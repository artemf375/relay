import Foundation
import RelayCore
import Testing
import UserNotifications
@testable import Relay

private enum AppModelTestError: LocalizedError {
    case durableRemoval

    var errorDescription: String? { "Could not update the durable queue" }
}

private actor ImmediateRelayClient: RelayAPIClient {
    let response: InboxResponse

    init(response: InboxResponse) { self.response = response }

    func inbox() async throws -> InboxResponse { response }
    func activities() async throws -> [RelayActivity] { [] }
    func endActivity(id: String) async throws -> RelayActivity { throw RelayAPIError.invalidResponse }
    func register(_ update: DeviceTokenUpdate) async throws {}
    func revokeDevice() async throws {}
    func submit(_ pending: PendingResponse) async throws -> RelayInteractionTerminalOutcome {
        .response(pending.response)
    }
}

private actor FailingRevokeRelayClient: RelayAPIClient {
    let response: InboxResponse

    init(response: InboxResponse) { self.response = response }

    func inbox() async throws -> InboxResponse { response }
    func activities() async throws -> [RelayActivity] { [] }
    func endActivity(id: String) async throws -> RelayActivity { throw RelayAPIError.invalidResponse }
    func register(_ update: DeviceTokenUpdate) async throws {}
    func revokeDevice() async throws { throw AppModelTestError.durableRemoval }
    func submit(_ pending: PendingResponse) async throws -> RelayInteractionTerminalOutcome {
        .response(pending.response)
    }
}

private actor ControlledInboxRelayClient: RelayAPIClient {
    private var continuations: [Int: CheckedContinuation<InboxResponse, any Error>] = [:]
    private var nextID = 0

    func inbox() async throws -> InboxResponse {
        let id = nextID
        nextID += 1
        return try await withCheckedThrowingContinuation { continuations[id] = $0 }
    }

    func register(_ update: DeviceTokenUpdate) async throws {}
    func activities() async throws -> [RelayActivity] { [] }
    func endActivity(id: String) async throws -> RelayActivity { throw RelayAPIError.invalidResponse }
    func revokeDevice() async throws {}
    func submit(_ pending: PendingResponse) async throws -> RelayInteractionTerminalOutcome {
        .response(pending.response)
    }

    func requestCount() -> Int { nextID }

    func complete(_ id: Int, with response: InboxResponse) {
        continuations.removeValue(forKey: id)?.resume(returning: response)
    }
}

private actor ActivityRelayClient: RelayAPIClient {
    let response: InboxResponse
    private var active: [RelayActivity]
    private(set) var endedIDs: [String] = []

    init(response: InboxResponse, activities: [RelayActivity]) {
        self.response = response
        self.active = activities
    }

    func inbox() async throws -> InboxResponse { response }
    func activities() async throws -> [RelayActivity] { active }
    func register(_ update: DeviceTokenUpdate) async throws {}
    func revokeDevice() async throws {}
    func submit(_ pending: PendingResponse) async throws -> RelayInteractionTerminalOutcome { .response(pending.response) }
    func endActivity(id: String) async throws -> RelayActivity {
        endedIDs.append(id)
        let activity = active.first { $0.id == id }!
        active.removeAll { $0.id == id }
        return activity
    }
}

@MainActor
private final class TestRemoteNotificationRegistration {
    var authorizationStatus: UNAuthorizationStatus = .denied
    private(set) var requestCount = 0

    func register() {
        requestCount += 1
    }
}

@MainActor
private final class TestResponseCoordinator: ResponseCoordinating {
    enum Behavior {
        case fail(any Error)
        case immediate(ResponseDeliveryDisposition)
        case suspended
    }

    var behavior: Behavior
    var flushError: (any Error)?
    var flushResult: ResponseFlushResult = .empty
    private var continuation: CheckedContinuation<ResponseDeliveryDisposition, any Error>?

    init(behavior: Behavior) { self.behavior = behavior }

    func configure(api: any RelayAPIClient) {}
    func flush() async throws -> ResponseFlushResult {
        if let flushError { throw flushError }
        return flushResult
    }
    func suspend() {}
    func clearAfterUnpair() throws {}

    func handleInbox(interactionID: String, response: InteractionResponse) async throws -> ResponseDeliveryDisposition {
        switch behavior {
        case .fail(let error): throw error
        case .immediate(let disposition): return disposition
        case .suspended:
            return try await withCheckedThrowingContinuation { continuation = $0 }
        }
    }

    var isWaiting: Bool { continuation != nil }

    func resume(with disposition: ResponseDeliveryDisposition) {
        continuation?.resume(returning: disposition)
        continuation = nil
    }
}

@Suite(.serialized)
@MainActor
struct AppModelTests {
    @Test func refreshesAndEndsOnlyTheSelectedLiveActivity() async throws {
        let snapshot = try inbox(status: "pending", response: nil)
        let activities = [
            RelayActivity(id: "act_build", title: "Build", status: "Running", progress: 0.4, staleAt: .distantFuture),
            RelayActivity(id: "act_deploy", title: "Deploy", status: "Waiting", progress: 0.1, staleAt: .distantFuture),
        ]
        let client = ActivityRelayClient(response: snapshot, activities: activities)
        var locallyEnded: [String] = []
        let model = AppModel(
            api: client,
            notificationCoordinator: TestResponseCoordinator(behavior: .immediate(.recorded)),
            clearConfiguration: {},
            endActivities: {},
            endActivityDisplay: { locallyEnded.append($0) }
        )

        await model.refresh()
        await model.endActivity(activities[0])

        #expect(model.activities.map(\.id) == ["act_deploy"])
        #expect(await client.endedIDs == ["act_build"])
        #expect(locallyEnded == ["act_build"])
    }

    @Test func activationRegistersAfterNotificationsAreEnabledInSettings() async throws {
        for enabledStatus in [
            UNAuthorizationStatus.authorized,
            .provisional,
            .ephemeral,
        ] {
            let registration = TestRemoteNotificationRegistration()
            let model = AppModel(
                api: ImmediateRelayClient(response: try inbox(status: "pending", response: nil)),
                notificationCoordinator: TestResponseCoordinator(behavior: .immediate(.recorded)),
                clearConfiguration: {},
                endActivities: {},
                notificationAuthorizationStatus: { registration.authorizationStatus },
                registerForRemoteNotifications: { registration.register() }
            )

            await model.becameActive()
            #expect(registration.requestCount == 0)

            registration.authorizationStatus = enabledStatus
            await model.becameActive()
            await model.becameActive()

            #expect(registration.requestCount == 1)
        }
    }

    @Test func aNewPairedSessionCanRequestItsAPNSTokenWithoutRepeatingOnEveryActivation() async throws {
        let registration = TestRemoteNotificationRegistration()
        registration.authorizationStatus = .authorized
        let inbox = try inbox(status: "pending", response: nil)
        let model = AppModel(
            api: ImmediateRelayClient(response: inbox),
            notificationCoordinator: TestResponseCoordinator(behavior: .immediate(.recorded)),
            clearConfiguration: {},
            endActivities: {},
            notificationAuthorizationStatus: { registration.authorizationStatus },
            registerForRemoteNotifications: { registration.register() }
        )

        await model.becameActive()
        await model.becameActive()
        #expect(registration.requestCount == 1)

        model.configureSession(api: ImmediateRelayClient(response: inbox))
        await model.becameActive()

        #expect(registration.requestCount == 2)
    }

    @Test func pairedErrorsDismissInPresentationOrder() async throws {
        let model = AppModel(
            api: FailingRevokeRelayClient(response: try inbox(status: "pending", response: nil)),
            notificationCoordinator: TestResponseCoordinator(behavior: .immediate(.recorded)),
            clearConfiguration: {},
            endActivities: {}
        )

        await model.pair(urlText: "not a URL", code: "AB12CD34")
        model.errorMessage = "Inbox is unavailable."
        await model.unpair()

        #expect(model.pairedErrorMessage == "Inbox is unavailable.")
        model.clearPairedError()

        #expect(model.pairedErrorMessage == "Could not revoke this phone: Could not update the durable queue")
        #expect(model.pairingErrorMessage == "Relay requires a complete HTTPS address.")

        model.clearPairedError()

        #expect(model.pairedErrorMessage == nil)
        #expect(model.pairingErrorMessage == "Relay requires a complete HTTPS address.")
    }

    @Test func editingPairingInputClearsOnlyThePairingError() async throws {
        let model = AppModel(
            api: ImmediateRelayClient(response: try inbox(status: "pending", response: nil)),
            notificationCoordinator: TestResponseCoordinator(behavior: .immediate(.recorded)),
            clearConfiguration: {},
            endActivities: {}
        )

        model.errorMessage = "Inbox is unavailable."
        await model.pair(urlText: "not a URL", code: "AB12CD34")
        #expect(model.pairingErrorMessage == "Relay requires a complete HTTPS address.")
        model.clearPairingError()

        #expect(model.pairingErrorMessage == nil)
        #expect(model.inboxErrorMessage == "Inbox is unavailable.")
    }

    @Test func terminalRefreshDoesNotEraseDurableRemovalFailure() async throws {
        let terminal = try inbox(status: "approved", response: "approve")
        let coordinator = TestResponseCoordinator(behavior: .fail(AppModelTestError.durableRemoval))
        let model = AppModel(
            api: ImmediateRelayClient(response: terminal),
            notificationCoordinator: coordinator,
            clearConfiguration: {},
            endActivities: {}
        )

        await model.respond(to: terminal.interactions[0], with: .approve)

        #expect(model.submissionStates["int_1"] == .failed("Could not update the durable queue"))
    }

    @Test func activationMarksExactResponsesFailedWhenDurableRemovalFails() async throws {
        let waiting = try inbox(status: "pending", response: nil)
        let pending = PendingResponse(interactionID: "int_1", response: .approve)
        let coordinator = TestResponseCoordinator(behavior: .immediate(.queued))
        let model = AppModel(
            api: ImmediateRelayClient(response: waiting),
            notificationCoordinator: coordinator,
            clearConfiguration: {},
            endActivities: {},
            notificationAuthorizationStatus: { .denied },
            registerForRemoteNotifications: {}
        )
        await model.respond(to: waiting.interactions[0], with: .approve)
        coordinator.flushError = ResponseFlushPersistenceError(
            responses: [pending],
            underlying: AppModelTestError.durableRemoval
        )

        await model.becameActive()

        #expect(model.submissionStates["int_1"] == .failed("Could not update the durable queue"))
    }

    @Test func manualRefreshRetriesQueuedResponseAndUpdatesItsState() async throws {
        let waiting = try inbox(status: "pending", response: nil)
        let coordinator = TestResponseCoordinator(behavior: .immediate(.queued))
        let model = AppModel(
            api: ImmediateRelayClient(response: waiting),
            notificationCoordinator: coordinator,
            clearConfiguration: {},
            endActivities: {}
        )
        await model.respond(to: waiting.interactions[0], with: .approve)
        #expect(model.submissionStates["int_1"] == .queued)
        coordinator.flushResult = ResponseFlushResult(
            recorded: [PendingResponse(interactionID: "int_1", response: .approve)],
            terminalOutcomes: [:]
        )

        await model.refresh()

        #expect(model.submissionStates["int_1"] == .recorded)
    }

    @Test func olderRefreshCannotOverwriteNewerTerminalSnapshot() async throws {
        let client = ControlledInboxRelayClient()
        let model = AppModel(
            api: client,
            notificationCoordinator: TestResponseCoordinator(behavior: .immediate(.recorded)),
            clearConfiguration: {},
            endActivities: {}
        )

        let older = Task { await model.refresh() }
        await waitUntil { await client.requestCount() == 1 }
        let newer = Task { await model.refresh() }
        await waitUntil { await client.requestCount() == 2 }
        await client.complete(1, with: try inbox(status: "approved", response: "approve"))
        await newer.value
        await client.complete(0, with: try inbox(status: "pending", response: nil))
        await older.value

        #expect(model.interactions.map(\.status) == [.approved])
    }

    @Test func responseCompletionAfterUnpairCannotRepopulateSubmissionState() async throws {
        let waiting = try inbox(status: "pending", response: nil)
        let coordinator = TestResponseCoordinator(behavior: .suspended)
        let model = AppModel(
            api: ImmediateRelayClient(response: waiting),
            notificationCoordinator: coordinator,
            clearConfiguration: {},
            endActivities: {}
        )
        let response = Task { await model.respond(to: waiting.interactions[0], with: .approve) }
        await waitUntil { coordinator.isWaiting }

        await model.unpair()
        coordinator.resume(with: .recorded)
        await response.value

        #expect(!model.isPaired)
        #expect(model.interactions.isEmpty)
        #expect(model.submissionStates.isEmpty)
    }

    @Test func unpairThenRepairInvalidatesThePreviousSessionRefresh() async throws {
        let oldClient = ControlledInboxRelayClient()
        let coordinator = TestResponseCoordinator(behavior: .immediate(.recorded))
        let model = AppModel(
            api: oldClient,
            notificationCoordinator: coordinator,
            clearConfiguration: {},
            endActivities: {}
        )
        let oldRefresh = Task { await model.refresh() }
        await waitUntil { await oldClient.requestCount() == 1 }

        await model.unpair()
        let repaired = try inbox(status: "approved", response: "approve")
        model.configureSession(api: ImmediateRelayClient(response: repaired))
        await model.refresh()
        await oldClient.complete(0, with: try inbox(status: "pending", response: nil))
        await oldRefresh.value

        #expect(model.isPaired)
        #expect(model.interactions.map(\.status) == [.approved])
        #expect(model.submissionStates.isEmpty)
    }

    private func inbox(status: String, response: String?) throws -> InboxResponse {
        let responseJSON = response.map { ",\"response\":\"\($0)\"" } ?? ",\"response\":null"
        let json = """
        {"interactions":[{"id":"int_1","title":"Deploy","prompt":"Ready?","kind":"approval","status":"\(status)"\(responseJSON),"expiresAt":"2026-08-07T10:00:00.000Z","createdAt":"2026-08-07T09:00:00.000Z"}],"notifications":[]}
        """
        return try RelayJSONDecoder.make().decode(
            InboxResponse.self,
            from: Data(json.utf8)
        )
    }

    private func waitUntil(_ condition: @escaping @MainActor () async -> Bool) async {
        for _ in 0..<100 where !(await condition()) { await Task.yield() }
    }
}

import Foundation
import Network
import OSLog
import RelayCore
import UIKit
import UserNotifications

struct ResponseFlushResult: Equatable {
    let recorded: Set<PendingResponse>
    let terminalOutcomes: [PendingResponse: RelayInteractionTerminalOutcome]

    static let empty = ResponseFlushResult(recorded: [], terminalOutcomes: [:])
}

struct ResponseFlushPersistenceError: LocalizedError {
    let responses: Set<PendingResponse>
    let underlying: any Error

    var errorDescription: String? { underlying.localizedDescription }
}

@MainActor
protocol ResponseCoordinating: AnyObject {
    func configure(api: any RelayAPIClient)
    func handleInbox(
        interactionID: String,
        response: InteractionResponse
    ) async throws -> ResponseDeliveryDisposition
    func flush() async throws -> ResponseFlushResult
    func suspend()
    func clearAfterUnpair() throws
}

@MainActor
final class NotificationCoordinator: ResponseCoordinating {
    typealias SubmitResponse = @Sendable (PendingResponse) async throws -> RelayInteractionTerminalOutcome

    static let shared = NotificationCoordinator()
    private let storage: FileResponseQueueStorage?
    private var queue: ResponseQueue?
    private var submitResponse: SubmitResponse?
    private let logger = Logger(subsystem: "Relay", category: "ResponseQueue")
    private let pathMonitor = NWPathMonitor()
    private var monitoringStarted = false
    private var reportedQueueRecovery = false

    private init() {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let storage = FileResponseQueueStorage(url: directory.appending(path: "response-queue.json"))
        self.storage = storage
        queue = try? ResponseQueue(storage: storage)
    }

    init(queue: ResponseQueue, submit: @escaping SubmitResponse) {
        storage = nil
        self.queue = queue
        submitResponse = submit
    }

    func configure(api: any RelayAPIClient) {
        submitResponse = { pending in try await api.submit(pending) }
        if !reportedQueueRecovery, let quarantineURL = storage?.quarantinedFileURL {
            reportedQueueRecovery = true
            reportQueueRecovery(quarantineURL)
        }
        if !monitoringStarted {
            monitoringStarted = true
            pathMonitor.pathUpdateHandler = { path in
                guard path.status == .satisfied else { return }
                Task { @MainActor in
                    do { _ = try await NotificationCoordinator.shared.flush() }
                    catch { NotificationCoordinator.shared.reportResponseFailure(error) }
                }
            }
            pathMonitor.start(queue: DispatchQueue(label: "Relay.network"))
        }
        Task {
            do { _ = try await flush() }
            catch { reportResponseFailure(error) }
        }
    }

    func handle(interactionID: String, responseCredential: String, response: InteractionResponse) async throws {
        let queue = try requireQueue()
        let requested = PendingResponse(
            interactionID: interactionID,
            responseCredential: responseCredential,
            response: response
        )
        let queued = try queue.enqueue(requested)
        let result = try await flush()
        if queued != requested { throw NotificationCoordinatorError.competingResponse }
        if let outcome = result.terminalOutcomes[queued] { throw NotificationCoordinatorError(outcome: outcome) }
    }

    func handleInbox(
        interactionID: String,
        response: InteractionResponse
    ) async throws -> ResponseDeliveryDisposition {
        let queue = try requireQueue()
        let requested = PendingResponse(interactionID: interactionID, response: response)
        let queued = try queue.enqueue(requested)
        let result = try await flush()
        guard queued == requested else { throw NotificationCoordinatorError.competingResponse }
        if result.recorded.contains(queued) { return .recorded }
        if let outcome = result.terminalOutcomes[queued] { throw NotificationCoordinatorError(outcome: outcome) }
        return .queued
    }

    func suspend() {
        submitResponse = nil
    }

    func clearAfterUnpair() throws {
        submitResponse = nil
        if let queue {
            try queue.clear()
        } else if let storage {
            try storage.save([])
            queue = try ResponseQueue(storage: storage)
        }
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
    }

    func flush() async throws -> ResponseFlushResult {
        guard let submitResponse else { return .empty }
        let queue = try requireQueue()
        var removed = Set<PendingResponse>()
        var recorded = Set<PendingResponse>()
        var terminalOutcomes: [PendingResponse: RelayInteractionTerminalOutcome] = [:]
        for pending in queue.pending {
            do {
                let outcome = try await submitResponse(pending)
                removed.insert(pending)
                if outcome == .response(pending.response) {
                    recorded.insert(pending)
                } else {
                    terminalOutcomes[pending] = outcome
                }
            } catch {
                continue
            }
        }
        do {
            try queue.remove(removed)
        } catch {
            throw ResponseFlushPersistenceError(responses: removed, underlying: error)
        }
        return ResponseFlushResult(recorded: recorded, terminalOutcomes: terminalOutcomes)
    }

    func reportResponseFailure(_ error: Error) {
        logger.error("A Relay response could not be persisted: \(error.localizedDescription, privacy: .public)")
        let content = UNMutableNotificationContent()
        content.title = "Relay response was not saved"
        content.body = "Open Relay and try the response again."
        content.sound = .default
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(
                identifier: "relay-response-storage-failure",
                content: content,
                trigger: nil
            )
        )
    }

    private func reportQueueRecovery(_ quarantineURL: URL) {
        logger.error("Relay quarantined an unreadable response queue at \(quarantineURL.path, privacy: .public)")
        let content = UNMutableNotificationContent()
        content.title = "Relay recovered its response queue"
        content.body = "A damaged response file was preserved. Check any unanswered prompt before continuing."
        content.sound = .default
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(
                identifier: "relay-response-queue-recovered",
                content: content,
                trigger: nil
            )
        )
    }

    private func requireQueue() throws -> ResponseQueue {
        guard let queue else { throw NotificationCoordinatorError.responseQueueUnavailable }
        return queue
    }
}

enum NotificationCoordinatorError: LocalizedError {
    case responseQueueUnavailable
    case competingResponse
    case serverRecordedDifferentResponse
    case interactionCanceled
    case interactionExpired

    init(outcome: RelayInteractionTerminalOutcome) {
        switch outcome {
        case .response: self = .serverRecordedDifferentResponse
        case .canceled: self = .interactionCanceled
        case .expired: self = .interactionExpired
        }
    }

    var errorDescription: String? {
        switch self {
        case .responseQueueUnavailable: "Relay could not open its durable response queue."
        case .competingResponse: "A different response is already queued for this interaction."
        case .serverRecordedDifferentResponse: "Relay already recorded a different response."
        case .interactionCanceled: "The interaction was canceled before this response was recorded."
        case .interactionExpired: "The interaction expired before this response was recorded."
        }
    }
}

extension Notification.Name { static let relayAPNSToken = Notification.Name("relayAPNSToken") }

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let approve = UNNotificationAction(identifier: "RELAY_APPROVE", title: "Approve")
        let deny = UNNotificationAction(identifier: "RELAY_DENY", title: "Deny", options: .destructive)
        let yes = UNNotificationAction(identifier: "RELAY_YES", title: "Yes")
        let no = UNNotificationAction(identifier: "RELAY_NO", title: "No")
        let reply = UNTextInputNotificationAction(
            identifier: "RELAY_REPLY",
            title: "Reply",
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Short reply"
        )
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: "RELAY_APPROVAL", actions: [approve, deny], intentIdentifiers: []),
            UNNotificationCategory(identifier: "RELAY_YES_NO", actions: [yes, no], intentIdentifiers: []),
            UNNotificationCategory(identifier: "RELAY_TEXT_REPLY", actions: [reply], intentIdentifiers: []),
        ])
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .relayAPNSToken, object: deviceToken.map { String(format: "%02x", $0) }.joined())
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping @Sendable () -> Void
    ) {
        guard let relay = response.notification.request.content.userInfo["relay"] as? [String: Any] else {
            completionHandler()
            return
        }
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
           let urlText = relay["url"] as? String,
           let url = URL(string: urlText),
           url.scheme == "https" {
            Task { @MainActor in
                await UIApplication.shared.open(url)
                completionHandler()
            }
            return
        }
        guard
              let interactionID = relay["interactionId"] as? String,
              let credential = relay["responseCredential"] as? String else {
            completionHandler()
            return
        }
        let text = (response as? UNTextInputNotificationResponse)?.userText
        guard let mapped = try? NotificationActionMapper.response(
            actionIdentifier: response.actionIdentifier,
            userText: text
        ) else {
            completionHandler()
            return
        }
        Task { @MainActor in
            do {
                try await NotificationCoordinator.shared.handle(
                    interactionID: interactionID,
                    responseCredential: credential,
                    response: mapped
                )
            } catch {
                NotificationCoordinator.shared.reportResponseFailure(error)
            }
            completionHandler()
        }
    }
}

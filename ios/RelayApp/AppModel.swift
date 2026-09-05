import Combine
import ActivityKit
import Foundation
import RelayCore
import UIKit
import UserNotifications

enum NotificationAuthorizationState: Equatable {
    case notDetermined
    case authorized
    case provisional
    case denied
}

@MainActor
final class AppModel: ObservableObject {
    @Published var interactions: [InboxInteraction] = []
    @Published var notifications: [InboxNotification] = []
    @Published private(set) var activities: [RelayActivity] = []
    @Published private(set) var endingActivityIDs: Set<String> = []
    @Published var isBusy = false
    @Published private(set) var isPaired = false
    @Published private(set) var submissionStates: [String: InteractionSubmissionState] = [:]
    @Published private(set) var inboxErrorMessage: String?
    @Published private(set) var pairingErrorMessage: String?
    @Published private(set) var unpairErrorMessage: String?
    @Published private(set) var notificationAuthorizationState: NotificationAuthorizationState = .notDetermined
    @Published private(set) var isUnpairing = false

    private var api: (any RelayAPIClient)?
    private var activityAPI: RelayAPI?
    private let notificationCoordinator: any ResponseCoordinating
    private let clearConfiguration: () throws -> Void
    private let endActivities: @MainActor () async -> Void
    private let endActivityDisplay: @MainActor (String) async -> Void
    private let notificationAuthorizationStatus: @MainActor () async -> UNAuthorizationStatus
    private let registerForRemoteNotifications: @MainActor () -> Void
    private let activityTokens = ActivityTokenCoordinator()
    private var submissionTracker = InteractionSubmissionTracker()
    private var sessionID = UUID()
    private var refreshSequence = 0
    private var responseOperations: [String: UUID] = [:]
    private var hasRequestedRemoteNotificationRegistration = false
    private var cancellables = Set<AnyCancellable>()
    private let environment: APNSEnvironment = {
        #if DEBUG
        return .sandbox
        #else
        return .production
        #endif
    }()

    var errorMessage: String? {
        get { pairingErrorMessage ?? inboxErrorMessage ?? unpairErrorMessage }
        set {
            guard newValue == nil else {
                inboxErrorMessage = newValue
                return
            }
            inboxErrorMessage = nil
            pairingErrorMessage = nil
            unpairErrorMessage = nil
        }
    }

    var pairedErrorMessage: String? {
        inboxErrorMessage ?? unpairErrorMessage
    }

    init() {
        notificationCoordinator = NotificationCoordinator.shared
        clearConfiguration = { try RelayConfigurationStore.clear() }
        endActivities = {
            for activity in Activity<RelayActivityAttributes>.activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
        endActivityDisplay = { id in
            for activity in Activity<RelayActivityAttributes>.activities
            where activity.attributes.relayActivityId == id {
                await activity.end(nil, dismissalPolicy: .immediate)
                break
            }
        }
        notificationAuthorizationStatus = {
            await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        }
        registerForRemoteNotifications = {
            UIApplication.shared.registerForRemoteNotifications()
        }
        observeAPNSToken()
        restore()
    }

    init(
        api: any RelayAPIClient,
        notificationCoordinator: any ResponseCoordinating,
        clearConfiguration: @escaping () throws -> Void,
        endActivities: @escaping @MainActor () async -> Void,
        endActivityDisplay: @escaping @MainActor (String) async -> Void = { _ in },
        notificationAuthorizationStatus: @escaping @MainActor () async -> UNAuthorizationStatus = {
            await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        },
        registerForRemoteNotifications: @escaping @MainActor () -> Void = {
            UIApplication.shared.registerForRemoteNotifications()
        }
    ) {
        self.api = api
        self.notificationCoordinator = notificationCoordinator
        self.clearConfiguration = clearConfiguration
        self.endActivities = endActivities
        self.endActivityDisplay = endActivityDisplay
        self.notificationAuthorizationStatus = notificationAuthorizationStatus
        self.registerForRemoteNotifications = registerForRemoteNotifications
        isPaired = true
        observeAPNSToken()
    }

    private func observeAPNSToken() {
        NotificationCenter.default.publisher(for: .relayAPNSToken)
            .compactMap { $0.object as? String }
            .sink { [weak self] token in Task { await self?.registerAPNSToken(token) } }
            .store(in: &cancellables)
    }

    func pair(urlText: String, code: String) async {
        let input = PairingInput(url: urlText, code: code)
        if let validationError = input.validationError {
            pairingErrorMessage = validationError.errorDescription
            return
        }
        guard let url = URL(string: input.normalizedURL) else {
            pairingErrorMessage = PairingValidationError.invalidHTTPSURL.errorDescription
            return
        }
        pairingErrorMessage = nil
        isBusy = true
        defer { isBusy = false }
        do {
            let enrolled = try await RelayAPI.enroll(
                baseURL: url,
                code: input.normalizedCode,
                deviceName: UIDevice.current.name
            )
            try RelayConfigurationStore.save(
                serverURL: url.absoluteString,
                deviceCredential: enrolled.credential
            )
            configure(url: url, credential: enrolled.credential)
        } catch { pairingErrorMessage = error.localizedDescription }
    }

    func clearPairingError() {
        pairingErrorMessage = nil
    }

    func clearPairedError() {
        if inboxErrorMessage != nil {
            inboxErrorMessage = nil
        } else {
            unpairErrorMessage = nil
        }
    }

    func clearUnpairError() {
        unpairErrorMessage = nil
    }

    private func fetchInbox() async {
        guard let api else { return }
        let session = sessionID
        refreshSequence += 1
        let request = refreshSequence
        do {
            async let inboxRequest = api.inbox()
            async let activitiesRequest = api.activities()
            let (inbox, activeActivities) = try await (inboxRequest, activitiesRequest)
            guard session == sessionID, request == refreshSequence else { return }
            interactions = inbox.interactions
            notifications = inbox.notifications ?? []
            activities = activeActivities
            submissionTracker.removeTerminalInteractions(in: inbox.interactions)
            submissionStates = submissionTracker.states
            inboxErrorMessage = nil
        }
        catch {
            guard session == sessionID, request == refreshSequence else { return }
            inboxErrorMessage = error.localizedDescription
        }
    }

    func endActivity(_ activity: RelayActivity) async {
        guard let api, !endingActivityIDs.contains(activity.id) else { return }
        endingActivityIDs.insert(activity.id)
        defer { endingActivityIDs.remove(activity.id) }
        do {
            _ = try await api.endActivity(id: activity.id)
            await endActivityDisplay(activity.id)
            activities.removeAll { $0.id == activity.id }
            inboxErrorMessage = nil
        } catch {
            inboxErrorMessage = "Could not end \(activity.title): \(error.localizedDescription)"
        }
    }

    func becameActive() async {
        await refreshNotificationAuthorization()
        if let activityAPI {
            await activityTokens.reconcile(api: activityAPI, environment: environment)
        }
        await refresh()
    }

    func refresh() async {
        guard api != nil else { return }
        let session = sessionID
        do {
            let result = try await notificationCoordinator.flush()
            guard session == sessionID else { return }
            submissionTracker.apply(result)
            submissionStates = submissionTracker.states
        }
        catch {
            guard session == sessionID else { return }
            if let persistenceError = error as? ResponseFlushPersistenceError {
                submissionTracker.fail(
                    persistenceError.responses,
                    message: persistenceError.localizedDescription
                )
                submissionStates = submissionTracker.states
            }
            inboxErrorMessage = error.localizedDescription
        }
        await fetchInbox()
    }

    func respond(to interaction: InboxInteraction, with response: InteractionResponse) async {
        let session = sessionID
        let operation = UUID()
        responseOperations[interaction.id] = operation
        submissionTracker.start(interaction.id, response: response)
        submissionStates = submissionTracker.states
        do {
            let disposition = try await notificationCoordinator.handleInbox(
                interactionID: interaction.id,
                response: response
            )
            guard session == sessionID, responseOperations[interaction.id] == operation else { return }
            submissionTracker.finish(interaction.id, response: response, disposition: disposition)
        } catch {
            guard session == sessionID, responseOperations[interaction.id] == operation else { return }
            submissionTracker.fail(interaction.id, response: response, message: error.localizedDescription)
        }
        responseOperations.removeValue(forKey: interaction.id)
        submissionStates = submissionTracker.states
        await fetchInbox()
    }

    func unpair() async {
        guard let currentAPI = api, !isUnpairing else { return }
        unpairErrorMessage = nil
        isUnpairing = true
        defer { isUnpairing = false }
        activityTokens.stop()
        notificationCoordinator.suspend()
        do {
            try await currentAPI.revokeDevice()
        } catch {
            if let apiError = error as? RelayAPIError, apiError.meansDeviceIsAlreadyRevoked {
                await finishUnpairing()
                return
            }
            notificationCoordinator.configure(api: currentAPI)
            if let activityAPI {
                activityTokens.start(api: activityAPI, environment: environment)
            }
            unpairErrorMessage = "Could not revoke this phone: \(error.localizedDescription)"
            return
        }
        await finishUnpairing()
    }

    private func finishUnpairing() async {
        invalidateSession()
        activityTokens.reset()
        do {
            try notificationCoordinator.clearAfterUnpair()
            try clearConfiguration()
        } catch {
            unpairErrorMessage = "Could not clear local Relay data. Try unpairing again: \(error.localizedDescription)"
            return
        }
        await endActivities()
        api = nil
        activityAPI = nil
        interactions = []
        notifications = []
        activities = []
        endingActivityIDs = []
        submissionTracker = InteractionSubmissionTracker()
        submissionStates = [:]
        isPaired = false
    }

    private func restore() {
        do {
            let stored = try RelayConfigurationStore.load()
            guard let urlString = stored.serverURL,
                  let url = URL(string: urlString),
                  let credential = stored.deviceCredential else { return }
            configure(url: url, credential: credential)
        } catch {
            pairingErrorMessage = error.localizedDescription
        }
    }

    private func configure(url: URL, credential: String) {
        let api = RelayAPI(baseURL: url, credential: credential)
        configureSession(api: api, activityAPI: api)
        Task {
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            await refreshNotificationAuthorization()
            await fetchInbox()
        }
    }

    func configureSession(api: any RelayAPIClient, activityAPI: RelayAPI? = nil) {
        invalidateSession()
        self.api = api
        self.activityAPI = activityAPI
        isPaired = true
        interactions = []
        notifications = []
        activities = []
        endingActivityIDs = []
        submissionTracker = InteractionSubmissionTracker()
        submissionStates = [:]
        hasRequestedRemoteNotificationRegistration = false
        notificationCoordinator.configure(api: api)
        if let activityAPI {
            activityTokens.start(api: activityAPI, environment: environment)
        }
    }

    private func registerAPNSToken(_ token: String) async {
        try? await api?.register(.apnsRegistration(token: token, environment: environment))
    }

    private func refreshNotificationAuthorization() async {
        let status = await notificationAuthorizationStatus()
        let refreshedState: NotificationAuthorizationState = switch status {
        case .notDetermined: .notDetermined
        case .denied: .denied
        case .provisional: .provisional
        case .authorized, .ephemeral: .authorized
        @unknown default: .denied
        }
        notificationAuthorizationState = refreshedState
        guard refreshedState.allowsRemoteNotificationRegistration else {
            hasRequestedRemoteNotificationRegistration = false
            return
        }
        if !hasRequestedRemoteNotificationRegistration {
            hasRequestedRemoteNotificationRegistration = true
            registerForRemoteNotifications()
        }
    }

    private func invalidateSession() {
        sessionID = UUID()
        refreshSequence += 1
        responseOperations.removeAll()
    }
}

private extension NotificationAuthorizationState {
    var allowsRemoteNotificationRegistration: Bool {
        switch self {
        case .authorized, .provisional: true
        case .notDetermined, .denied: false
        }
    }
}

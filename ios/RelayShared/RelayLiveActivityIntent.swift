import AppIntents
import ActivityKit
import Foundation
import RelayCore

struct RelayLiveActivityResponseIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Respond to Relay"
    static let description = IntentDescription("Answers a pending Relay interaction.")
    static let openAppWhenRun = false
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @Parameter(title: "Interaction") var interactionID: String
    @Parameter(title: "Action") var action: String

    init() {
        interactionID = ""
        action = ""
    }

    init(interactionID: String, action: LiveActivityInteractionAction) {
        self.interactionID = interactionID
        self.action = action.rawValue
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        do {
            guard let action = LiveActivityInteractionAction(rawValue: action) else {
                throw RelayLiveActivityIntentError.invalidAction
            }
            let activity = Activity<RelayActivityAttributes>.activities.first(where: {
                $0.content.state.checkpoint?.interactionID == interactionID
            })
            let kind = activity?.content.state.checkpoint?.kind ?? action.expectedKind
            let configuration = try RelayIntentConfiguration.load()
            let builder = RelayRequestBuilder(
                baseURL: configuration.baseURL,
                deviceCredential: configuration.credential
            )
            let client = LiveActivityResponseClient(builder: builder) { request in
                try await URLSession.shared.data(for: request, delegate: RelayRedirectPolicy())
            }
            let result = try await client.submit(
                interactionID: interactionID,
                kind: kind,
                action: action
            )
            if let activity,
               activity.content.state.checkpoint?.interactionID == interactionID {
                let current = activity.content
                let acknowledged = current.state.acknowledging(result)
                await activity.update(
                    ActivityContent(
                        state: acknowledged,
                        staleDate: current.staleDate,
                        relevanceScore: current.relevanceScore
                    )
                )
            }
            return .result(dialog: IntentDialog(stringLiteral: result.label))
        } catch {
            return .result(dialog: IntentDialog("Relay could not send that response."))
        }
    }
}

private enum RelayLiveActivityIntentError: Error {
    case invalidAction
}

private extension LiveActivityInteractionAction {
    var expectedKind: LiveActivityCheckpointKind {
        switch self {
        case .approve, .deny: .approval
        case .yes, .no: .yesNo
        }
    }
}

private enum RelayIntentConfiguration {
    static func load() throws -> LiveActivityResponseConfiguration {
        let stored = try RelayConfigurationStore.load()
        return try LiveActivityResponseConfiguration(
            urlString: stored.serverURL,
            credential: stored.deviceCredential
        )
    }
}

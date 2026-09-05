import RelayCore

enum ResponseDeliveryDisposition: Equatable {
    case recorded
    case queued
}

enum InteractionSubmissionState: Equatable {
    case idle
    case sending
    case queued
    case recorded
    case failed(String)
}

struct InteractionSubmissionTracker {
    private struct Submission {
        let response: InteractionResponse
        var state: InteractionSubmissionState
    }

    private var submissions: [String: Submission] = [:]

    var states: [String: InteractionSubmissionState] {
        submissions.mapValues(\.state)
    }

    subscript(interactionID: String) -> InteractionSubmissionState {
        submissions[interactionID]?.state ?? .idle
    }

    mutating func start(_ interactionID: String, response: InteractionResponse) {
        submissions[interactionID] = Submission(response: response, state: .sending)
    }

    mutating func finish(
        _ interactionID: String,
        response: InteractionResponse,
        disposition: ResponseDeliveryDisposition
    ) {
        guard submissions[interactionID]?.response == response else { return }
        switch disposition {
        case .recorded:
            submissions[interactionID]?.state = .recorded
        case .queued:
            submissions[interactionID]?.state = .queued
        }
    }

    mutating func fail(_ interactionID: String, response: InteractionResponse, message: String) {
        guard submissions[interactionID]?.response == response else { return }
        submissions[interactionID]?.state = .failed(message)
    }

    mutating func apply(_ result: ResponseFlushResult) {
        for pending in result.recorded {
            finish(pending.interactionID, response: pending.response, disposition: .recorded)
        }
        for (pending, outcome) in result.terminalOutcomes {
            fail(
                pending.interactionID,
                response: pending.response,
                message: NotificationCoordinatorError(outcome: outcome).localizedDescription
            )
        }
    }

    mutating func fail(_ responses: Set<PendingResponse>, message: String) {
        for pending in responses {
            fail(pending.interactionID, response: pending.response, message: message)
        }
    }

    mutating func removeTerminalInteractions(in interactions: [InboxInteraction]) {
        for interaction in interactions where interaction.status != .pending {
            guard submissions[interaction.id]?.state == .recorded else { continue }
            submissions.removeValue(forKey: interaction.id)
        }
    }
}

struct InboxPresentation {
    let waiting: [InboxInteraction]
    let earlierInteractions: [InboxInteraction]
    let notifications: [InboxNotification]

    init(interactions: [InboxInteraction], notifications: [InboxNotification]) {
        waiting = interactions
            .filter { $0.status == .pending }
            .sorted { $0.createdAt > $1.createdAt }
        earlierInteractions = interactions
            .filter { $0.status != .pending }
            .sorted { $0.createdAt > $1.createdAt }
        self.notifications = notifications.sorted { $0.createdAt > $1.createdAt }
    }
}

extension InboxInteraction {
    var statusSymbol: String {
        switch status {
        case .pending: "hourglass"
        case .approved, .yes: "checkmark.circle.fill"
        case .denied, .no: "xmark.circle.fill"
        case .replied: "text.bubble.fill"
        case .canceled: "xmark.circle"
        case .expired: "clock.badge.xmark"
        case .unsupported: "questionmark.circle"
        }
    }

    var statusLabel: String {
        status == .pending ? "Waiting" : status.label
    }

    var actionsAvailable: Bool {
        guard status == .pending else { return false }
        if case .unsupported = kind { return false }
        return true
    }
}

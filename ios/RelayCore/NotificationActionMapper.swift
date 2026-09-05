import Foundation

public enum NotificationActionError: Error { case unknownAction, missingText }

public enum NotificationActionMapper {
    public static func response(actionIdentifier: String, userText: String?) throws -> InteractionResponse {
        switch actionIdentifier {
        case "RELAY_APPROVE": return .approve
        case "RELAY_DENY": return .deny
        case "RELAY_YES": return .yes
        case "RELAY_NO": return .no
        case "RELAY_REPLY":
            let text = userText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !text.isEmpty else { throw NotificationActionError.missingText }
            return .reply(text)
        default: throw NotificationActionError.unknownAction
        }
    }
}

import Foundation

public enum RelayJSONDecoder {
    public static func make() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = fractional.date(from: value) { return date }
            let standard = ISO8601DateFormatter()
            standard.formatOptions = [.withInternetDateTime]
            if let date = standard.date(from: value) { return date }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid Relay ISO-8601 date"
            )
        }
        return decoder
    }
}

public enum InteractionResponse: Equatable, Hashable, Sendable {
    case approve
    case deny
    case yes
    case no
    case reply(String)
}

extension InteractionResponse: Codable {
    private enum CodingKeys: String, CodingKey { case action, text }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let action = try container.decode(String.self, forKey: .action)
        switch action {
        case "approve": self = .approve
        case "deny": self = .deny
        case "yes": self = .yes
        case "no": self = .no
        case "reply": self = .reply(try container.decode(String.self, forKey: .text))
        default: throw DecodingError.dataCorruptedError(forKey: .action, in: container, debugDescription: "Unknown response action")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .approve: try container.encode("approve", forKey: .action)
        case .deny: try container.encode("deny", forKey: .action)
        case .yes: try container.encode("yes", forKey: .action)
        case .no: try container.encode("no", forKey: .action)
        case .reply(let text):
            try container.encode("reply", forKey: .action)
            try container.encode(text, forKey: .text)
        }
    }
}

public struct PendingResponse: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String { interactionID }
    public let interactionID: String
    public let responseCredential: String?
    public let response: InteractionResponse

    public init(interactionID: String, responseCredential: String? = nil, response: InteractionResponse) {
        self.interactionID = interactionID
        self.responseCredential = responseCredential
        self.response = response
    }
}

public enum APNSEnvironment: String, Codable, Sendable { case sandbox, production }

public struct DeviceCapabilities: Codable, Sendable {
    public let liveActivityInteractions: Int

    public static let liveActivityInteractionsV1 = Self(liveActivityInteractions: 1)

    public init(liveActivityInteractions: Int) {
        self.liveActivityInteractions = liveActivityInteractions
    }
}

public struct DeviceTokenUpdate: Codable, Sendable {
    public let apnsToken: String?
    public let pushToStartToken: String?
    public let environment: APNSEnvironment
    public let capabilities: DeviceCapabilities?

    public init(
        apnsToken: String? = nil,
        pushToStartToken: String? = nil,
        environment: APNSEnvironment,
        capabilities: DeviceCapabilities? = nil
    ) {
        self.apnsToken = apnsToken
        self.pushToStartToken = pushToStartToken
        self.environment = environment
        self.capabilities = capabilities
    }

    public static func apnsRegistration(token: String, environment: APNSEnvironment) -> Self {
        Self(
            apnsToken: token,
            environment: environment,
            capabilities: .liveActivityInteractionsV1
        )
    }
}

public struct ActivityPushTokenUpdate: Codable, Sendable {
    public let activityPushToken: String
    public let activityId: String
    public let environment: APNSEnvironment

    public init(activityPushToken: String, activityId: String, environment: APNSEnvironment) {
        self.activityPushToken = activityPushToken
        self.activityId = activityId
        self.environment = environment
    }
}

public struct RelayActivity: Codable, Identifiable, Sendable {
    public let id: String
    public let key: String?
    public let title: String
    public let status: String
    public let detail: String?
    public let progress: Double
    public let symbol: String
    public let accentColor: String
    public let state: String
    public let sequence: Int
    public let staleAt: Date
    public let endReason: String?

    public init(
        id: String,
        key: String? = nil,
        title: String,
        status: String,
        detail: String? = nil,
        progress: Double,
        symbol: String = "terminal",
        accentColor: String = "#5ED8B7",
        state: String = "active",
        sequence: Int = 1,
        staleAt: Date,
        endReason: String? = nil
    ) {
        self.id = id
        self.key = key
        self.title = title
        self.status = status
        self.detail = detail
        self.progress = progress
        self.symbol = symbol
        self.accentColor = accentColor
        self.state = state
        self.sequence = sequence
        self.staleAt = staleAt
        self.endReason = endReason
    }
}

public struct ActivityListResponse: Codable, Sendable {
    public let activities: [RelayActivity]
}

public enum InboxInteractionKind: Codable, Equatable, Sendable {
    case approval
    case yesNo
    case text
    case unsupported(String)

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        switch value {
        case "approval": self = .approval
        case "yes_no": self = .yesNo
        case "text": self = .text
        default: self = .unsupported(value)
        }
    }

    public func encode(to encoder: Encoder) throws {
        let value: String
        switch self {
        case .approval: value = "approval"
        case .yesNo: value = "yes_no"
        case .text: value = "text"
        case .unsupported(let rawValue): value = rawValue
        }
        var container = encoder.singleValueContainer()
        try container.encode(value)
    }
}

public enum InboxInteractionStatus: Codable, Equatable, Sendable {
    case pending
    case approved
    case denied
    case yes
    case no
    case replied
    case canceled
    case expired
    case unsupported(String)

    private var rawValue: String {
        switch self {
        case .pending: "pending"
        case .approved: "approved"
        case .denied: "denied"
        case .yes: "yes"
        case .no: "no"
        case .replied: "replied"
        case .canceled: "canceled"
        case .expired: "expired"
        case .unsupported(let rawValue): rawValue
        }
    }

    public var label: String { rawValue.replacingOccurrences(of: "_", with: " ").capitalized }

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        switch value {
        case "pending": self = .pending
        case "approved": self = .approved
        case "denied": self = .denied
        case "yes": self = .yes
        case "no": self = .no
        case "replied": self = .replied
        case "canceled": self = .canceled
        case "expired": self = .expired
        default: self = .unsupported(value)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public struct InboxInteraction: Codable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let prompt: String
    public let kind: InboxInteractionKind
    public let status: InboxInteractionStatus
    public let response: String?
    public let expiresAt: Date
    public let createdAt: Date
}

public struct InboxResponse: Codable, Sendable {
    public let interactions: [InboxInteraction]
    public let notifications: [InboxNotification]?
}

public struct InboxNotification: Codable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let body: String
    public let url: URL?
    public let status: String
    public let createdAt: Date
}

public struct EnrollmentResponse: Codable, Sendable {
    public let id: String
    public let credential: String
    public let name: String
}

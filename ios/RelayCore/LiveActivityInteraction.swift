import Foundation

public enum LiveActivityPresentation: String, Codable, Hashable, Sendable {
    case task
    case checkpoint
    case acknowledged
}

public enum LiveActivityCheckpointKind: String, Codable, Hashable, Sendable {
    case approval
    case yesNo = "yes_no"
}

public enum LiveActivityCheckpointResult: String, Codable, Hashable, Sendable {
    case approve
    case deny
    case yes
    case no
    case canceled
    case expired

    public var label: String {
        switch self {
        case .approve: "Approved"
        case .deny: "Denied"
        case .yes: "Yes"
        case .no: "No"
        case .canceled: "Canceled"
        case .expired: "Expired"
        }
    }
}

public struct LiveActivityCheckpoint: Codable, Hashable, Sendable {
    public let interactionID: String
    public let kind: LiveActivityCheckpointKind
    public let prompt: String
    public let expiresAt: Date
    public let result: LiveActivityCheckpointResult?

    public init(
        interactionID: String,
        kind: LiveActivityCheckpointKind,
        prompt: String,
        expiresAt: Date,
        result: LiveActivityCheckpointResult?
    ) {
        self.interactionID = interactionID
        self.kind = kind
        self.prompt = prompt
        self.expiresAt = expiresAt
        self.result = result
    }

    private enum CodingKeys: String, CodingKey {
        case interactionID = "interactionId"
        case kind
        case prompt
        case expiresAt
        case result
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        interactionID = try container.decode(String.self, forKey: .interactionID)
        kind = try container.decode(LiveActivityCheckpointKind.self, forKey: .kind)
        prompt = try container.decode(String.self, forKey: .prompt)
        result = try container.decodeIfPresent(LiveActivityCheckpointResult.self, forKey: .result)
        let value = try container.decode(String.self, forKey: .expiresAt)
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        guard let date = fractional.date(from: value) ?? standard.date(from: value) else {
            throw DecodingError.dataCorruptedError(
                forKey: .expiresAt,
                in: container,
                debugDescription: "Invalid Relay checkpoint expiry"
            )
        }
        expiresAt = date
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(interactionID, forKey: .interactionID)
        try container.encode(kind, forKey: .kind)
        try container.encode(prompt, forKey: .prompt)
        try container.encodeIfPresent(result, forKey: .result)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        try container.encode(formatter.string(from: expiresAt), forKey: .expiresAt)
    }
}

public enum LiveActivityInteractionError: Error, Equatable {
    case actionMismatch
    case invalidInteractionID
}

public enum LiveActivityInteractionAction: String, Codable, CaseIterable, Hashable, Sendable {
    case approve
    case deny
    case yes
    case no

    public func response(for kind: LiveActivityCheckpointKind) throws -> InteractionResponse {
        switch (kind, self) {
        case (.approval, .approve): .approve
        case (.approval, .deny): .deny
        case (.yesNo, .yes): .yes
        case (.yesNo, .no): .no
        default: throw LiveActivityInteractionError.actionMismatch
        }
    }

    public var response: InteractionResponse {
        switch self {
        case .approve: .approve
        case .deny: .deny
        case .yes: .yes
        case .no: .no
        }
    }

    public var result: LiveActivityCheckpointResult {
        LiveActivityCheckpointResult(rawValue: rawValue)!
    }
}

public extension RelayRequestBuilder {
    func liveActivityResponseRequest(
        interactionID: String,
        action: LiveActivityInteractionAction
    ) throws -> URLRequest {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        guard let encodedID = interactionID.addingPercentEncoding(withAllowedCharacters: allowed),
              !encodedID.isEmpty else {
            throw LiveActivityInteractionError.invalidInteractionID
        }
        return try request(
            path: "/v1/device/interactions/\(encodedID)/respond",
            method: "POST",
            body: action.response
        )
    }
}

public enum LiveActivityResponseClientError: Error, Equatable {
    case invalidResponse
    case server(String)
}

private struct LiveActivityResponseEnvelope: Decodable {
    struct Interaction: Decodable {
        let status: String
        let response: LiveActivityCheckpointResult?

        var result: LiveActivityCheckpointResult? {
            if let response { return response }
            switch status {
            case "approved": return .approve
            case "denied": return .deny
            case "yes": return .yes
            case "no": return .no
            case "canceled": return .canceled
            case "expired": return .expired
            default: return nil
            }
        }
    }

    let interaction: Interaction
}

public enum LiveActivityResponseConfigurationError: Error, Equatable {
    case invalidConfiguration
}

public struct LiveActivityResponseConfiguration: Sendable {
    public let baseURL: URL
    public let credential: String

    public init(urlString: String?, credential: String?) throws {
        guard let urlString,
              let baseURL = URL(string: urlString),
              baseURL.scheme == "https",
              baseURL.host != nil,
              let credential,
              !credential.isEmpty else {
            throw LiveActivityResponseConfigurationError.invalidConfiguration
        }
        self.baseURL = baseURL
        self.credential = credential
    }
}

public struct LiveActivityResponseClient: Sendable {
    public typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    private let builder: RelayRequestBuilder
    private let transport: Transport

    public init(builder: RelayRequestBuilder, transport: @escaping Transport) {
        self.builder = builder
        self.transport = transport
    }

    public func submit(
        interactionID: String,
        kind: LiveActivityCheckpointKind,
        action: LiveActivityInteractionAction
    ) async throws -> LiveActivityCheckpointResult {
        _ = try action.response(for: kind)
        var request = try builder.liveActivityResponseRequest(
            interactionID: interactionID,
            action: action
        )
        request.timeoutInterval = 12
        let (data, response) = try await transport(request)
        guard let http = response as? HTTPURLResponse else {
            throw LiveActivityResponseClientError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw LiveActivityResponseClientError.server(message ?? "Relay rejected the response")
        }
        guard let envelope = try? JSONDecoder().decode(LiveActivityResponseEnvelope.self, from: data),
              let result = envelope.interaction.result else {
            throw LiveActivityResponseClientError.invalidResponse
        }
        return result
    }
}

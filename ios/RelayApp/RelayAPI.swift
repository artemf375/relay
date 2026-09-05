import Foundation
import RelayCore

enum RelayInteractionTerminalOutcome: Equatable, Sendable {
    case response(InteractionResponse)
    case canceled
    case expired
}

protocol RelayAPIClient: Sendable {
    func inbox() async throws -> InboxResponse
    func activities() async throws -> [RelayActivity]
    func endActivity(id: String) async throws -> RelayActivity
    func register(_ update: DeviceTokenUpdate) async throws
    func revokeDevice() async throws
    func submit(_ pending: PendingResponse) async throws -> RelayInteractionTerminalOutcome
}

actor RelayAPI: RelayAPIClient {
    private let builder: RelayRequestBuilder
    private let session: URLSession
    private let decoder: JSONDecoder

    init(baseURL: URL, credential: String, session: URLSession = .shared) {
        self.builder = RelayRequestBuilder(baseURL: baseURL, deviceCredential: credential)
        self.session = session
        self.decoder = RelayJSONDecoder.make()
    }

    static func enroll(baseURL: URL, code: String, deviceName: String) async throws -> EnrollmentResponse {
        let endpoint = baseURL.appending(path: "/v1/devices/enroll")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(EnrollmentRequest(code: code, deviceName: deviceName))
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder().decode(EnrollmentResponse.self, from: data)
    }

    func register(_ update: DeviceTokenUpdate) async throws {
        let request = try builder.request(path: "/v1/device/push-tokens", method: "PUT", body: update)
        let (data, response) = try await session.data(for: request)
        try Self.validate(response: response, data: data)
    }

    func registerActivityToken(_ update: ActivityPushTokenUpdate) async throws {
        let request = try builder.request(
            path: "/v1/device/activities/\(update.activityId)/push-token",
            method: "PUT",
            body: update
        )
        let (data, response) = try await session.data(for: request)
        try Self.validate(response: response, data: data)
    }

    func removeActivityToken(activityID: String) async throws {
        let request = try builder.request(path: "/v1/device/activities/\(activityID)/push-token", method: "DELETE")
        let (data, response) = try await session.data(for: request)
        try Self.validate(response: response, data: data)
    }

    func reportActivityDismissed(activityID: String) async throws {
        let request = try builder.request(path: "/v1/device/activities/\(activityID)/dismissed", method: "POST")
        let (data, response) = try await session.data(for: request)
        try Self.validate(response: response, data: data)
    }

    func inbox() async throws -> InboxResponse {
        let request = try builder.request(path: "/v1/inbox")
        let (data, response) = try await session.data(for: request)
        try Self.validate(response: response, data: data)
        return try decoder.decode(InboxResponse.self, from: data)
    }

    func activities() async throws -> [RelayActivity] {
        let request = try builder.request(path: "/v1/device/activities")
        let (data, response) = try await session.data(for: request)
        try Self.validate(response: response, data: data)
        return try decoder.decode(ActivityListResponse.self, from: data).activities
    }

    func endActivity(id: String) async throws -> RelayActivity {
        let request = try builder.request(path: "/v1/device/activities/\(id)/end", method: "POST")
        let (data, response) = try await session.data(for: request)
        try Self.validate(response: response, data: data)
        return try decoder.decode(ActivityEnvelope.self, from: data).activity
    }

    func respondFromInbox(
        interactionID: String,
        response: InteractionResponse
    ) async throws -> RelayInteractionTerminalOutcome {
        let request = try builder.request(
            path: "/v1/device/interactions/\(interactionID)/respond",
            method: "POST",
            body: response
        )
        let (data, urlResponse) = try await session.data(for: request)
        try Self.validate(response: urlResponse, data: data)
        return try Self.decodeWinningResponse(from: data)
    }

    func submit(_ pending: PendingResponse) async throws -> RelayInteractionTerminalOutcome {
        guard let responseCredential = pending.responseCredential else {
            return try await respondFromInbox(interactionID: pending.interactionID, response: pending.response)
        }
        let responseData = try JSONEncoder().encode(pending.response)
        var object = try JSONSerialization.jsonObject(with: responseData) as! [String: Any]
        object["responseCredential"] = responseCredential
        var request = try builder.request(path: "/v1/interactions/\(pending.interactionID)/respond", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: object)
        let (data, urlResponse) = try await session.data(for: request)
        try Self.validate(response: urlResponse, data: data)
        return try Self.decodeWinningResponse(from: data)
    }

    func revokeDevice() async throws {
        let request = try builder.request(path: "/v1/device", method: "DELETE")
        let (data, response) = try await session.data(for: request)
        try Self.validate(response: response, data: data)
    }

    private static func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw RelayAPIError.requestFailed(status: 0, message: "Relay returned an invalid response")
        }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw RelayAPIError.requestFailed(status: http.statusCode, message: message ?? "Relay request failed")
        }
    }

    private static func decodeWinningResponse(from data: Data) throws -> RelayInteractionTerminalOutcome {
        let envelope = try JSONDecoder().decode(ResponseEnvelope.self, from: data)
        switch envelope.interaction.status {
        case "approved": return .response(.approve)
        case "denied": return .response(.deny)
        case "yes": return .response(.yes)
        case "no": return .response(.no)
        case "replied":
            guard let response = envelope.interaction.response else { throw RelayAPIError.invalidResponse }
            return .response(.reply(response))
        case "canceled": return .canceled
        case "expired": return .expired
        default: throw RelayAPIError.invalidResponse
        }
    }
}

private struct EnrollmentRequest: Codable { let code: String; let deviceName: String }
private struct ResponseEnvelope: Decodable {
    struct Interaction: Decodable {
        let status: String
        let response: String?
    }

    let interaction: Interaction
}
private struct ActivityEnvelope: Decodable { let activity: RelayActivity }
enum RelayAPIError: LocalizedError {
    case requestFailed(status: Int, message: String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .requestFailed(_, let message): message
        case .invalidResponse: "Relay returned an invalid interaction response."
        }
    }

    var meansDeviceIsAlreadyRevoked: Bool {
        if case .requestFailed(let status, _) = self { status == 401 || status == 404 } else { false }
    }
}

import Foundation
import RelayCore
import Testing
@testable import Relay

private final class RelayAPIURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var responseData = Data()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseData)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@Suite(.serialized)
struct RelayAPIResponseTests {
    @Test(arguments: [
        ("approved", "approve", RelayInteractionTerminalOutcome.response(.approve)),
        ("denied", "deny", RelayInteractionTerminalOutcome.response(.deny)),
        ("canceled", nil, RelayInteractionTerminalOutcome.canceled),
        ("expired", nil, RelayInteractionTerminalOutcome.expired),
    ])
    func decodesServerTerminalWinnerDirectly(
        status: String,
        response: String?,
        expected: RelayInteractionTerminalOutcome
    ) async throws {
        let responseJSON = response.map { ",\"response\":\"\($0)\"" } ?? ",\"response\":null"
        RelayAPIURLProtocol.responseData = Data(
            """
            {"interaction":{"id":"int_1","title":"Deploy","prompt":"Ready?","kind":"approval","status":"\(status)"\(responseJSON),"expiresAt":"2026-08-07T10:00:00.000Z","createdAt":"2026-08-07T09:00:00.000Z"},"activityDelivery":null}
            """.utf8
        )
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RelayAPIURLProtocol.self]
        let api = RelayAPI(
            baseURL: URL(string: "https://relay.example.com")!,
            credential: "relay_device_test",
            session: URLSession(configuration: configuration)
        )

        let outcome = try await api.respondFromInbox(interactionID: "int_1", response: .approve)

        #expect(outcome == expected)
    }
}

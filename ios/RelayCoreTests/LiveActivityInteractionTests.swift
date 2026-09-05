import Foundation
import Testing
@testable import RelayCore

private actor TransportProbe {
    private(set) var wasCalled = false

    func markCalled() {
        wasCalled = true
    }
}

@Test func liveActivityActionsMapToBinaryResponses() throws {
    #expect(try LiveActivityInteractionAction.approve.response(for: .approval) == .approve)
    #expect(try LiveActivityInteractionAction.deny.response(for: .approval) == .deny)
    #expect(try LiveActivityInteractionAction.yes.response(for: .yesNo) == .yes)
    #expect(try LiveActivityInteractionAction.no.response(for: .yesNo) == .no)
    #expect(throws: LiveActivityInteractionError.actionMismatch) {
        try LiveActivityInteractionAction.approve.response(for: .yesNo)
    }
}

@Test func buildsAuthenticatedLiveActivityResponseRequest() throws {
    let builder = RelayRequestBuilder(
        baseURL: URL(string: "https://relay.example.com")!,
        deviceCredential: "relay_device_secret"
    )

    let request = try builder.liveActivityResponseRequest(
        interactionID: "int_1",
        action: .approve
    )

    #expect(request.url?.absoluteString == "https://relay.example.com/v1/device/interactions/int_1/respond")
    #expect(request.httpMethod == "POST")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer relay_device_secret")
    #expect(try JSONSerialization.jsonObject(with: request.httpBody!) as? [String: String] == ["action": "approve"])
}

@Test func checkpointStateEncodesDisplayDataWithoutCredentials() throws {
    let checkpoint = LiveActivityCheckpoint(
        interactionID: "int_1",
        kind: .approval,
        prompt: "Deploy?",
        expiresAt: Date(timeIntervalSince1970: 1_786_017_600),
        result: nil
    )

    let data = try JSONEncoder().encode(checkpoint)
    let text = String(decoding: data, as: UTF8.self)

    #expect(text.contains("Deploy?"))
    #expect(!text.localizedCaseInsensitiveContains("credential"))
    #expect(!text.localizedCaseInsensitiveContains("token"))
}

@Test func checkpointDecodesTheServerActivityKitShape() throws {
    let data = Data(#"{"interactionId":"int_1","kind":"yes_no","prompt":"Continue?","expiresAt":"2026-08-06T20:30:00.000Z","result":null}"#.utf8)

    let checkpoint = try JSONDecoder().decode(LiveActivityCheckpoint.self, from: data)
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

    #expect(checkpoint.interactionID == "int_1")
    #expect(checkpoint.kind == .yesNo)
    #expect(checkpoint.expiresAt == formatter.date(from: "2026-08-06T20:30:00.000Z"))
}

@Test func liveActivityResponseClientUsesInjectedTransportAndReturnsAcknowledgement() async throws {
    let builder = RelayRequestBuilder(
        baseURL: URL(string: "https://relay.example.com")!,
        deviceCredential: "relay_device_secret"
    )
    let client = LiveActivityResponseClient(builder: builder) { request in
        #expect(request.timeoutInterval == 12)
        return (
            Data(#"{"interaction":{"status":"approved","response":"approve"}}"#.utf8),
            HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/2",
                headerFields: nil
            )!
        )
    }

    let result = try await client.submit(interactionID: "int_1", kind: .approval, action: .approve)

    #expect(result == .approve)
}

@Test func liveActivityResponseClientReturnsTheServerWinnerForACompetingTap() async throws {
    let builder = RelayRequestBuilder(
        baseURL: URL(string: "https://relay.example.com")!,
        deviceCredential: "relay_device_secret"
    )
    let client = LiveActivityResponseClient(builder: builder) { request in
        (
            Data(#"{"interaction":{"status":"approved","response":"approve"}}"#.utf8),
            HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/2",
                headerFields: nil
            )!
        )
    }

    let result = try await client.submit(interactionID: "int_1", kind: .approval, action: .deny)

    #expect(result == .approve)
}

@Test func liveActivityResponseClientReportsServerRejection() async throws {
    let builder = RelayRequestBuilder(
        baseURL: URL(string: "https://relay.example.com")!,
        deviceCredential: "relay_device_secret"
    )
    let client = LiveActivityResponseClient(builder: builder) { request in
        (
            Data(#"{"error":"Interaction is already terminal"}"#.utf8),
            HTTPURLResponse(
                url: request.url!,
                statusCode: 409,
                httpVersion: "HTTP/2",
                headerFields: nil
            )!
        )
    }

    await #expect(throws: LiveActivityResponseClientError.server("Interaction is already terminal")) {
        try await client.submit(interactionID: "int_1", kind: .approval, action: .deny)
    }
}

@Test func liveActivityResponseClientRejectsMismatchedActionBeforeTransport() async throws {
    let builder = RelayRequestBuilder(
        baseURL: URL(string: "https://relay.example.com")!,
        deviceCredential: "relay_device_secret"
    )
    let transportProbe = TransportProbe()
    let client = LiveActivityResponseClient(builder: builder) { request in
        await transportProbe.markCalled()
        return (
            Data(),
            HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/2", headerFields: nil)!
        )
    }

    await #expect(throws: LiveActivityInteractionError.actionMismatch) {
        try await client.submit(interactionID: "int_1", kind: .yesNo, action: .approve)
    }
    #expect(await transportProbe.wasCalled == false)
}

@Test func liveActivityResponseConfigurationRequiresHTTPSAndCredential() throws {
    #expect(throws: LiveActivityResponseConfigurationError.invalidConfiguration) {
        try LiveActivityResponseConfiguration(urlString: nil, credential: "relay_device_secret")
    }
    #expect(throws: LiveActivityResponseConfigurationError.invalidConfiguration) {
        try LiveActivityResponseConfiguration(urlString: "http://relay.example.com", credential: "relay_device_secret")
    }
    #expect(throws: LiveActivityResponseConfigurationError.invalidConfiguration) {
        try LiveActivityResponseConfiguration(urlString: "https://relay.example.com", credential: nil)
    }

    let configuration = try LiveActivityResponseConfiguration(
        urlString: "https://relay.example.com",
        credential: "relay_device_secret"
    )
    #expect(configuration.baseURL.absoluteString == "https://relay.example.com")
    #expect(configuration.credential == "relay_device_secret")
}

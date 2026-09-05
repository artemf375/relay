import XCTest
@testable import RelayCore

final class RelayJSONDecoderTests: XCTestCase {
    func testDecodesServerDatesWithFractionalSeconds() throws {
        let data = Data(#"{"interactions":[{"id":"int_1","title":"Relay","prompt":"Ready?","kind":"yes_no","status":"pending","response":null,"expiresAt":"2026-08-06T12:00:00.123Z","createdAt":"2026-08-06T11:00:00.456Z"}]}"#.utf8)
        let inbox = try RelayJSONDecoder.make().decode(InboxResponse.self, from: data)
        XCTAssertEqual(inbox.interactions.first?.id, "int_1")
        XCTAssertEqual(inbox.interactions.first?.kind, .yesNo)
        XCTAssertEqual(inbox.interactions.first?.status, .pending)
    }

    func testPreservesUnknownInteractionKindsForNonInteractiveFallbackUI() throws {
        let data = Data(#"{"interactions":[{"id":"int_1","title":"Relay","prompt":"Ready?","kind":"future_kind","status":"pending","response":null,"expiresAt":"2026-08-06T12:00:00.123Z","createdAt":"2026-08-06T11:00:00.456Z"}]}"#.utf8)

        let inbox = try RelayJSONDecoder.make().decode(InboxResponse.self, from: data)

        XCTAssertEqual(inbox.interactions.first?.kind, .unsupported("future_kind"))
    }

    func testPreservesUnknownInteractionStatusesWithoutShowingResponseControls() throws {
        let data = Data(#"{"interactions":[{"id":"int_1","title":"Relay","prompt":"Ready?","kind":"approval","status":"future_status","response":null,"expiresAt":"2026-08-06T12:00:00.123Z","createdAt":"2026-08-06T11:00:00.456Z"}]}"#.utf8)

        let inbox = try RelayJSONDecoder.make().decode(InboxResponse.self, from: data)

        XCTAssertEqual(inbox.interactions.first?.status, .unsupported("future_status"))
    }

    func testAPNSRegistrationAdvertisesLiveActivityInteractionSupportWithoutAnActivityToken() throws {
        let update = DeviceTokenUpdate.apnsRegistration(
            token: String(repeating: "a", count: 64),
            environment: .production
        )

        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(update)) as? [String: Any])
        XCTAssertEqual(object["apnsToken"] as? String, String(repeating: "a", count: 64))
        XCTAssertEqual(
            (object["capabilities"] as? [String: Any])?["liveActivityInteractions"] as? Int,
            1
        )
    }
}

import XCTest
@testable import RelayCore

final class NotificationActionMapperTests: XCTestCase {
    func testMapsBoundedActionsAndTextReplies() throws {
        XCTAssertEqual(
            try NotificationActionMapper.response(actionIdentifier: "RELAY_APPROVE", userText: nil),
            .approve
        )
        XCTAssertEqual(
            try NotificationActionMapper.response(actionIdentifier: "RELAY_REPLY", userText: " Ship it "),
            .reply("Ship it")
        )
        XCTAssertThrowsError(
            try NotificationActionMapper.response(actionIdentifier: "RELAY_REPLY", userText: "  ")
        )
        XCTAssertThrowsError(
            try NotificationActionMapper.response(actionIdentifier: "UNRECOGNIZED", userText: nil)
        )
    }
}

import Foundation
import XCTest
@testable import RelayCore

final class RelayRedirectPolicyTests: XCTestCase {
    func testRedirectsStayOnOriginalHTTPSOrigin() async {
        let original = URL(string: "https://relay.example.com/start")!
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: original)
        let response = HTTPURLResponse(url: original, statusCode: 307, httpVersion: nil, headerFields: nil)!
        for (destination, allowed) in [
            ("https://relay.example.com/next", true),
            ("https://relay.example.com:443/next", true),
            ("http://relay.example.com/next", false),
            ("https://other.example.com/next", false),
            ("https://relay.example.com:8443/next", false),
        ] {
            var request = URLRequest(url: URL(string: destination)!)
            request.setValue("Bearer test", forHTTPHeaderField: "Authorization")
            let redirected: URLRequest? = await withCheckedContinuation { continuation in
                RelayRedirectPolicy().urlSession(session, task: task,
                    willPerformHTTPRedirection: response, newRequest: request) {
                    continuation.resume(returning: $0)
                }
            }
            XCTAssertEqual(redirected != nil, allowed, destination)
            if allowed { XCTAssertEqual(redirected, request) }
        }
    }
}

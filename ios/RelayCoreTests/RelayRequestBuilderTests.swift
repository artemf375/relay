import XCTest
@testable import RelayCore

final class RelayRequestBuilderTests: XCTestCase {
    func testBuildsAuthenticatedRequestsWithoutLeakingCredentialIntoURL() throws {
        let builder = RelayRequestBuilder(
            baseURL: URL(string: "https://relay.example.com")!,
            deviceCredential: "relay_device_secret"
        )
        let request = try builder.request(
            path: "/v1/device/push-tokens",
            method: "PUT",
            body: DeviceTokenUpdate(apnsToken: String(repeating: "a", count: 64), environment: .production)
        )

        XCTAssertEqual(request.url?.absoluteString, "https://relay.example.com/v1/device/push-tokens")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer relay_device_secret")
        XCTAssertFalse(request.url!.absoluteString.contains("relay_device_secret"))
        XCTAssertNotNil(request.httpBody)
    }
}

import Testing
@testable import Relay

@Test func pairingInputNormalizesAndValidates() {
    let valid = PairingInput(url: " https://relay.example.com/ ", code: " ab12cd34 ")

    #expect(valid.normalizedURL == "https://relay.example.com/")
    #expect(valid.normalizedCode == "AB12CD34")
    #expect(PairingInput(url: "https:///", code: "AB12CD34").validationError == .invalidHTTPSURL)
    #expect(PairingInput(url: "https://relay.example.com/", code: "ABC").validationError == .invalidCodeLength)
    #expect(valid.validationError == nil)
    #expect(valid.isPairingEnabled)
    #expect(!PairingInput(url: "https://relay.example.com/", code: "ABC").isPairingEnabled)
}

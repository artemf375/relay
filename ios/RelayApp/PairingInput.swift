import Foundation

struct PairingInput: Equatable {
    var url: String
    var code: String

    var normalizedURL: String { url.trimmingCharacters(in: .whitespacesAndNewlines) }
    var normalizedCode: String { code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }

    var validationError: PairingValidationError? {
        guard !normalizedURL.isEmpty else { return .missingURL }
        guard let value = URL(string: normalizedURL), value.scheme == "https", value.host != nil else {
            return .invalidHTTPSURL
        }
        guard normalizedCode.count == 8 else { return .invalidCodeLength }
        return nil
    }

    var isPairingEnabled: Bool {
        validationError == nil
    }
}

enum PairingValidationError: LocalizedError, Equatable {
    case missingURL, invalidHTTPSURL, invalidCodeLength

    var errorDescription: String? {
        switch self {
        case .missingURL: "Enter your Relay address."
        case .invalidHTTPSURL: "Relay requires a complete HTTPS address."
        case .invalidCodeLength: "Enter the eight-character pairing code."
        }
    }
}

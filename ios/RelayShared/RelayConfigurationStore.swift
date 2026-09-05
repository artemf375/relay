import Foundation
import Security

struct RelayStoredConfiguration {
    let serverURL: String?
    let deviceCredential: String?
}

enum RelayConfigurationStore {
    private static let defaultsSuiteName = Bundle.main.object(forInfoDictionaryKey: "RelayAppGroup") as! String
    private static let keychainService = Bundle.main.object(forInfoDictionaryKey: "RelayKeychainService") as! String
    private static let keychainAccessGroup = Bundle.main.object(forInfoDictionaryKey: "RelayKeychainAccessGroup") as! String
    private static let credentialAccount = "deviceCredential"
    private static let serverURLKey = "relayServerURL"

    static func load() throws -> RelayStoredConfiguration {
        let defaults = try sharedDefaults()
        return RelayStoredConfiguration(
            serverURL: defaults.string(forKey: serverURLKey),
            deviceCredential: keychainValue()
        )
    }

    static func save(serverURL: String, deviceCredential: String) throws {
        let defaults = try sharedDefaults()
        let data = Data(deviceCredential.utf8)
        let query = keychainQuery()
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        defaults.set(serverURL, forKey: serverURLKey)
    }

    static func clear() throws {
        let status = SecItemDelete(keychainQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        try sharedDefaults().removeObject(forKey: serverURLKey)
    }

    private static func keychainValue() -> String? {
        var query = keychainQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func keychainQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: credentialAccount,
            kSecAttrAccessGroup as String: keychainAccessGroup,
        ]
    }

    private static func sharedDefaults() throws -> UserDefaults {
        guard let defaults = UserDefaults(suiteName: defaultsSuiteName) else {
            throw RelayConfigurationStoreError.sharedDefaultsUnavailable
        }
        return defaults
    }
}

private enum RelayConfigurationStoreError: LocalizedError {
    case sharedDefaultsUnavailable

    var errorDescription: String? { "Relay could not open its shared configuration store." }
}

import Foundation
import Security

actor TokenVault {
    private let service = "com.rafaypair.app.authentication"
    private let account = "active-session"

    func load() throws -> TokenPair? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw VaultError.keychain(status)
        }

        do {
            return try JSONDecoder.rafayPair.decode(TokenPair.self, from: data)
        } catch {
            try? clear()
            throw VaultError.corruptEntry
        }
    }

    func save(_ tokens: TokenPair) throws {
        let data = try JSONEncoder.rafayPair.encode(tokens)
        let lookup: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        let updateStatus = SecItemUpdate(lookup as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecItemNotFound {
            var insert = lookup
            for (key, value) in attributes {
                insert[key] = value
            }
            let insertStatus = SecItemAdd(insert as CFDictionary, nil)
            guard insertStatus == errSecSuccess else { throw VaultError.keychain(insertStatus) }
        } else if updateStatus != errSecSuccess {
            throw VaultError.keychain(updateStatus)
        }
    }

    func clear() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw VaultError.keychain(status)
        }
    }
}

enum VaultError: LocalizedError, Sendable {
    case keychain(OSStatus)
    case corruptEntry

    var errorDescription: String? {
        switch self {
        case .keychain(let status): "Secure credential storage failed (\(status))."
        case .corruptEntry: "Stored credentials were invalid and have been removed."
        }
    }
}

extension JSONEncoder {
    static var rafayPair: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }
}

extension JSONDecoder {
    static var rafayPair: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { value in
            let container = try value.singleValueContainer()
            let raw = try container.decode(String.self)
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = fractional.date(from: raw) { return date }
            let standard = ISO8601DateFormatter()
            standard.formatOptions = [.withInternetDateTime]
            if let date = standard.date(from: raw) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid RFC 3339 timestamp")
        }
        return decoder
    }
}

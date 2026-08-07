import Foundation
import Security

protocol AppAttestKeyIDStoring: Sendable {
    func load(for userID: UUID) async throws -> String?
    func save(_ keyID: String, for userID: UUID) async throws
    func remove(for userID: UUID) async throws
}

actor AppAttestKeyIDVault: AppAttestKeyIDStoring {
    private let service = "com.rafaypair.app.app-attest-key-id"

    func load(for userID: UUID) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(for: userID),
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard
            status == errSecSuccess,
            let data = result as? Data,
            let keyID = String(data: data, encoding: .utf8),
            Self.isCanonicalKeyID(keyID)
        else {
            if status == errSecSuccess { try? remove(for: userID) }
            throw VaultError.keychain(status == errSecSuccess ? errSecDecode : status)
        }
        return keyID
    }

    func save(_ keyID: String, for userID: UUID) throws {
        guard Self.isCanonicalKeyID(keyID), let data = keyID.data(using: .utf8) else {
            throw VaultError.corruptEntry
        }
        let lookup: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(for: userID),
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

    func remove(for userID: UUID) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account(for: userID),
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw VaultError.keychain(status)
        }
    }

    private func account(for userID: UUID) -> String {
        userID.uuidString.lowercased()
    }

    private static func isCanonicalKeyID(_ value: String) -> Bool {
        guard
            value.count == 44,
            value.last == "=",
            let decoded = Data(base64Encoded: value),
            decoded.count == 32
        else { return false }
        return decoded.base64EncodedString() == value
    }
}

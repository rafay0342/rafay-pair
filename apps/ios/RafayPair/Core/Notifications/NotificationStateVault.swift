import Foundation
import Security

struct NotificationClientState: Codable, Equatable, Sendable {
    var apnsToken: String?
    var registeredDeviceID: UUID?
    var registeredUserID: UUID?
    var seenCareRequestIDs: [UUID]

    static let empty = NotificationClientState(
        apnsToken: nil,
        registeredDeviceID: nil,
        registeredUserID: nil,
        seenCareRequestIDs: []
    )

    mutating func resetAccountState(preservingToken: Bool = true) {
        if !preservingToken { apnsToken = nil }
        registeredDeviceID = nil
        registeredUserID = nil
        seenCareRequestIDs = []
    }

    mutating func recordSeenCareRequests(_ ids: [UUID], limit: Int = 512) {
        var ordered = ids
        let incoming = Set(ids)
        ordered.append(contentsOf: seenCareRequestIDs.filter { !incoming.contains($0) })
        seenCareRequestIDs = Array(ordered.prefix(limit))
    }
}

actor NotificationStateVault {
    private let service: String
    private let account: String

    init(
        service: String = "com.rafaypair.app.notifications",
        account: String = "device-registration"
    ) {
        self.service = service
        self.account = account
    }

    func load() throws -> NotificationClientState {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return .empty }
        guard status == errSecSuccess, let data = result as? Data else {
            throw VaultError.keychain(status)
        }
        do {
            return try JSONDecoder.rafayPair.decode(NotificationClientState.self, from: data)
        } catch {
            try? clear()
            throw VaultError.corruptEntry
        }
    }

    func save(_ state: NotificationClientState) throws {
        let data = try JSONEncoder.rafayPair.encode(state)
        let lookup: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            // Background remote notifications can run after the first device unlock.
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

import Foundation
import UserNotifications

protocol NotificationDeviceLifecycle: Sendable {
    func disableCurrentDevice() async throws
}

protocol NotificationDelivery: Sendable {
    func requestAuthorizationIfNeeded() async
    func isAuthorizedForVisibleNotifications() async -> Bool
    func deliverGenericCareUpdate() async throws
}

actor SystemNotificationDelivery: NotificationDelivery {
    private let center = UNUserNotificationCenter.current()

    func requestAuthorizationIfNeeded() async {
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .notDetermined else { return }
        _ = try? await center.requestAuthorization(options: [.alert, .badge, .sound])
    }

    func isAuthorizedForVisibleNotifications() async -> Bool {
        let status = await center.notificationSettings().authorizationStatus
        return status == .authorized || status == .provisional || status == .ephemeral
    }

    func deliverGenericCareUpdate() async throws {
        let content = UNMutableNotificationContent()
        content.title = "RafayPair"
        content.body = "You have a new care update. Open RafayPair to view it."
        content.sound = .default
        content.userInfo = ["rafaypair-local-kind": "authenticated-care-update"]
        let request = UNNotificationRequest(
            identifier: "rafaypair-care-update",
            content: content,
            trigger: nil
        )
        try await center.add(request)
    }
}

enum CareNotificationPolicy {
    static func pendingIncomingIDs(
        in requests: [CareRequest],
        currentUserID: UUID
    ) -> [UUID] {
        requests
            .filter { $0.recipientUserId == currentUserID && $0.status == .pending }
            .sorted { $0.createdAt > $1.createdAt }
            .map(\.id)
    }

    static func unseenIDs(current: [UUID], seen: [UUID]) -> [UUID] {
        let seenSet = Set(seen)
        return current.filter { !seenSet.contains($0) }
    }
}

enum AuthenticatedWakeOutcome: Sendable {
    case newData
    case noData
    case failed
}

actor RemoteNotificationDeviceService: NotificationDeviceLifecycle {
    private let api: APIClient
    private let stateVault: NotificationStateVault
    private let installationIdentifier: InstallationIdentifier
    private let delivery: any NotificationDelivery

    init(
        api: APIClient,
        stateVault: NotificationStateVault,
        installationIdentifier: InstallationIdentifier,
        delivery: any NotificationDelivery
    ) {
        self.api = api
        self.stateVault = stateVault
        self.installationIdentifier = installationIdentifier
        self.delivery = delivery
    }

    func recordAndRegister(apnsToken: String) async {
        guard PushTokenPolicy.isValid(apnsToken) else { return }
        do {
            var state = try await stateVault.load()
            state.apnsToken = apnsToken
            try await stateVault.save(state)
            try await registerStoredToken()
        } catch {
            // APNs may deliver a token before authentication is restored. The token is
            // retained in Keychain and activation retries through the authenticated path.
        }
    }

    func registerStoredToken() async throws {
        var state = try await stateVault.load()
        guard let token = state.apnsToken, PushTokenPolicy.isValid(token) else { return }

        let currentUser: CurrentUserResponse = try await api.authenticated("/v1/auth/me")
        let installationID = await installationIdentifier.value()
        let previousDeviceID = state.registeredDeviceID
        let previousUserID = state.registeredUserID
        let response: NotificationDeviceResponse = try await api.authenticated(
            "/v1/notification-devices",
            method: .post,
            body: RegisterNotificationDeviceRequest(
                platform: .ios,
                token: token,
                installationId: installationID
            )
        )

        if let previousDeviceID,
            previousDeviceID != response.device.id,
            previousUserID == currentUser.user.id
        {
            try? await api.authenticatedVoid(
                "/v1/notification-devices/\(previousDeviceID.uuidString)",
                method: .delete
            )
        }

        if previousUserID != currentUser.user.id {
            state.seenCareRequestIDs = []
        }
        state.registeredDeviceID = response.device.id
        state.registeredUserID = currentUser.user.id
        try await stateVault.save(state)
    }

    func disableCurrentDevice() async throws {
        var state = try await stateVault.load()
        if let deviceID = state.registeredDeviceID {
            try await api.authenticatedVoid(
                "/v1/notification-devices/\(deviceID.uuidString)",
                method: .delete
            )
        }
        state.resetAccountState()
        try await stateVault.save(state)
    }

    func performAuthenticatedCareWake() async -> AuthenticatedWakeOutcome {
        do {
            var state = try await stateVault.load()
            // A push can only be sent after a successful authenticated registration, which
            // records its account owner in Keychain. One authenticated care request keeps the
            // background execution within APNs time limits and avoids trusting push fields.
            guard let registeredUserID = state.registeredUserID else { return .noData }
            let response: CareRequestListResponse = try await api.authenticated("/v1/care-requests")
            let pending = CareNotificationPolicy.pendingIncomingIDs(
                in: response.items,
                currentUserID: registeredUserID
            )
            let unseen = CareNotificationPolicy.unseenIDs(
                current: pending,
                seen: state.seenCareRequestIDs
            )
            guard !unseen.isEmpty else {
                state.recordSeenCareRequests(pending)
                try await stateVault.save(state)
                return .noData
            }
            if await delivery.isAuthorizedForVisibleNotifications() {
                try await delivery.deliverGenericCareUpdate()
            }
            state.recordSeenCareRequests(pending)
            try await stateVault.save(state)
            return .newData
        } catch APIError.notAuthenticated {
            // A contentless wake after logout is expected and contains no user data.
            return .noData
        } catch {
            // A failed or unauthorized refetch must never produce a visible notification.
            return .failed
        }
    }
}

actor InstallationIdentifier {
    private let defaults: UserDefaults
    private let key: String

    init(
        defaults: UserDefaults = .standard,
        key: String = "RPNotificationInstallationID"
    ) {
        self.defaults = defaults
        self.key = key
    }

    func value() -> UUID {
        if let raw = defaults.string(forKey: key), let existing = UUID(uuidString: raw) {
            return existing
        }
        let generated = UUID()
        defaults.set(generated.uuidString.lowercased(), forKey: key)
        return generated
    }
}

enum PushTokenPolicy {
    static func isValid(_ token: String) -> Bool {
        (64...4096).contains(token.utf8.count) && token.allSatisfy(\.isHexDigit)
    }
}

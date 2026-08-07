import Foundation

protocol AuthRepository: Sendable {
    func restoreSession() async throws -> User
    func register(email: String, password: String, displayName: String) async throws -> User
    func login(email: String, password: String) async throws -> User
    func logout() async
}

protocol PairRepository: Sendable {
    func current() async throws -> PairSummary?
    func create() async throws -> PairSummary
    func join(code: String) async throws -> PairSummary
    func disconnect() async throws
}

protocol ConsentRepository: Sendable {
    func list() async throws -> [ConsentGrant]
    func update(scope: ConsentScope, enabled: Bool) async throws -> ConsentGrant
}

protocol CareRepository: Sendable {
    func list() async throws -> [CareRequest]
    func send(kind: CareRequestKind, note: String?, idempotencyKey: UUID) async throws -> CareRequest
    func respond(id: UUID, response: CareRequestStatus) async throws -> CareRequest
}

protocol PrivacyRepository: Sendable {
    func current() async throws -> PrivacyState
    func pause() async throws -> PrivacyState
    func resume() async throws -> PrivacyState
}

actor RemoteAuthRepository: AuthRepository {
    private let api: APIClient
    private let vault: TokenVault
    private let notificationDevices: (any NotificationDeviceLifecycle)?

    init(
        api: APIClient,
        vault: TokenVault,
        notificationDevices: (any NotificationDeviceLifecycle)? = nil
    ) {
        self.api = api
        self.vault = vault
        self.notificationDevices = notificationDevices
    }

    func restoreSession() async throws -> User {
        guard try await vault.load() != nil else { throw APIError.notAuthenticated }
        let response: CurrentUserResponse = try await api.authenticated("/v1/auth/me")
        return response.user
    }

    func register(email: String, password: String, displayName: String) async throws -> User {
        let response: AuthResponse = try await api.unauthenticated(
            "/v1/auth/register",
            method: .post,
            body: RegisterRequest(email: email, password: password, displayName: displayName)
        )
        try await vault.save(response.session)
        return response.user
    }

    func login(email: String, password: String) async throws -> User {
        let response: AuthResponse = try await api.unauthenticated(
            "/v1/auth/login",
            method: .post,
            body: LoginRequest(email: email, password: password)
        )
        try await vault.save(response.session)
        return response.user
    }

    func logout() async {
        // The authenticated device registration must be disabled before the session is
        // revoked and the Keychain tokens are erased. Failure is safe: pushes contain no
        // content and a signed-out client cannot perform the authenticated refetch.
        try? await notificationDevices?.disableCurrentDevice()
        if let tokens = try? await vault.load() {
            try? await api.unauthenticatedVoid(
                "/v1/auth/logout",
                method: .post,
                body: RefreshRequest(refreshToken: tokens.refreshToken)
            )
        }
        try? await vault.clear()
    }
}

actor RemotePairRepository: PairRepository {
    private let api: APIClient

    init(api: APIClient) {
        self.api = api
    }

    func current() async throws -> PairSummary? {
        do {
            let response: PairResponse = try await api.authenticated("/v1/pairs/current")
            return response.pair
        } catch APIError.server(let problem) where problem.status == 404 {
            return nil
        }
    }

    func create() async throws -> PairSummary {
        let response: PairResponse = try await api.authenticated("/v1/pairs/current", method: .post)
        return response.pair
    }

    func join(code: String) async throws -> PairSummary {
        let response: PairResponse = try await api.authenticated(
            "/v1/pairs/join",
            method: .post,
            body: JoinPairRequest(code: code)
        )
        return response.pair
    }

    func disconnect() async throws {
        try await api.authenticatedVoid("/v1/pairs/current", method: .delete)
    }
}

actor RemoteConsentRepository: ConsentRepository {
    private let api: APIClient

    init(api: APIClient) {
        self.api = api
    }

    func list() async throws -> [ConsentGrant] {
        let response: ConsentListResponse = try await api.authenticated("/v1/consents")
        return response.grants
    }

    func update(scope: ConsentScope, enabled: Bool) async throws -> ConsentGrant {
        let response: ConsentListResponse = try await api.authenticated(
            "/v1/consents",
            method: .put,
            body: UpdateConsentRequest(grants: [ConsentMutation(capability: scope, granted: enabled)])
        )
        guard let updated = response.grants.first(where: { $0.capability == scope }) else {
            throw APIError.invalidResponse
        }
        return updated
    }
}

actor RemoteCareRepository: CareRepository {
    private let api: APIClient

    init(api: APIClient) {
        self.api = api
    }

    func list() async throws -> [CareRequest] {
        let response: CareRequestListResponse = try await api.authenticated("/v1/care-requests")
        return response.items
    }

    func send(kind: CareRequestKind, note: String?, idempotencyKey: UUID) async throws -> CareRequest {
        let response: CareRequestResponse = try await api.authenticated(
            "/v1/care-requests",
            method: .post,
            body: CreateCareRequest(clientRequestId: idempotencyKey, kind: kind, message: note)
        )
        return response.careRequest
    }

    func respond(id: UUID, response: CareRequestStatus) async throws -> CareRequest {
        let careResponse: CareResponse
        switch response {
        case .accepted: careResponse = .accepted
        case .declined: careResponse = .declined
        case .pending, .expired: throw APIError.invalidResponse
        }
        let result: CareRequestResponse = try await api.authenticated(
            "/v1/care-requests/\(id.uuidString)/respond",
            method: .post,
            body: RespondToCareRequest(response: careResponse)
        )
        return result.careRequest
    }
}

actor RemotePrivacyRepository: PrivacyRepository {
    private let api: APIClient

    init(api: APIClient) {
        self.api = api
    }

    func current() async throws -> PrivacyState {
        let response: PrivacyStateResponse = try await api.authenticated("/v1/privacy")
        return response.privacy
    }

    func pause() async throws -> PrivacyState {
        let response: PrivacyStateResponse = try await api.authenticated("/v1/privacy/pause", method: .post)
        return response.privacy
    }

    func resume() async throws -> PrivacyState {
        let response: PrivacyStateResponse = try await api.authenticated("/v1/privacy/resume", method: .post)
        return response.privacy
    }
}

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

protocol TogetherRepository: Sendable {
    func current() async throws -> TogetherSession?
    func invite(activity: TogetherActivity) async throws -> TogetherSession?
    func respond(id: UUID, accepted: Bool) async throws -> TogetherSession?
    func publish(id: UUID, state: PublishTogetherStateRequest) async throws -> TogetherSession?
    func end(id: UUID) async throws -> TogetherSession?
}

actor RemoteTogetherRepository: TogetherRepository {
    private let api: APIClient

    init(api: APIClient) {
        self.api = api
    }

    func current() async throws -> TogetherSession? {
        do {
            let response: TogetherSessionResponse = try await api.authenticated(
                "/v1/together-sessions/current"
            )
            return response.session
        } catch APIError.server(let problem) where problem.status == 404 {
            return nil
        }
    }

    func invite(activity: TogetherActivity) async throws -> TogetherSession? {
        let response: TogetherSessionResponse = try await api.authenticated(
            "/v1/together-sessions",
            method: .post,
            body: CreateTogetherSessionRequest(activity: activity)
        )
        return response.session
    }

    func respond(id: UUID, accepted: Bool) async throws -> TogetherSession? {
        let response: TogetherSessionResponse = try await api.authenticated(
            "/v1/together-sessions/\(id.uuidString.lowercased())/respond",
            method: .post,
            body: RespondTogetherSessionRequest(response: accepted ? "accepted" : "declined")
        )
        return response.session
    }

    func publish(
        id: UUID,
        state: PublishTogetherStateRequest
    ) async throws -> TogetherSession? {
        let response: TogetherSessionResponse = try await api.authenticated(
            "/v1/together-sessions/\(id.uuidString.lowercased())/state",
            method: .put,
            body: state
        )
        return response.session
    }

    func end(id: UUID) async throws -> TogetherSession? {
        let response: TogetherSessionResponse = try await api.authenticated(
            "/v1/together-sessions/\(id.uuidString.lowercased())/end",
            method: .post
        )
        return response.session
    }
}

protocol BloodPressureRepository: Sendable {
    func readings() async throws -> BloodPressureListResponse
    func record(_ request: RecordBloodPressureRequest) async throws -> BloodPressureReading
    func importReading(_ request: ImportBloodPressureRequest) async throws -> BloodPressureReading
    func delete(id: UUID) async throws
}

actor RemoteBloodPressureRepository: BloodPressureRepository {
    private let api: APIClient

    init(api: APIClient) {
        self.api = api
    }

    func readings() async throws -> BloodPressureListResponse {
        try await api.authenticated("/v1/blood-pressure")
    }

    func record(_ request: RecordBloodPressureRequest) async throws -> BloodPressureReading {
        let response: BloodPressureResponse = try await api.authenticated(
            "/v1/blood-pressure",
            method: .post,
            body: request
        )
        return response.reading
    }

    /// Importing the same record twice returns the reading that already exists
    /// rather than a second one, so a repeated Health sync is safe to run.
    func importReading(_ request: ImportBloodPressureRequest) async throws -> BloodPressureReading {
        let response: BloodPressureResponse = try await api.authenticated(
            "/v1/blood-pressure/imports",
            method: .post,
            body: request
        )
        return response.reading
    }

    func delete(id: UUID) async throws {
        try await api.authenticatedVoid(
            "/v1/blood-pressure/\(id.uuidString.lowercased())",
            method: .delete
        )
    }
}

protocol AssistantRepository: Sendable {
    func memories() async throws -> AiMemoryListResponse
    func addMemory(category: AiMemoryCategory, content: String) async throws -> AiMemory
    func deleteMemory(id: UUID) async throws
    func forgetAll() async throws
    func currentSession() async throws -> AiSession?
    func startSession() async throws -> AiSession?
    func markIdentityAnnounced(id: UUID) async throws -> AiSession?
    func endSession(id: UUID) async throws -> AiSession?
    func voiceTicket(id: UUID) async throws -> AiVoiceTicket
}

actor RemoteAssistantRepository: AssistantRepository {
    private let api: APIClient

    init(api: APIClient) {
        self.api = api
    }

    func memories() async throws -> AiMemoryListResponse {
        try await api.authenticated("/v1/ai/memories")
    }

    func addMemory(category: AiMemoryCategory, content: String) async throws -> AiMemory {
        let response: AiMemoryResponse = try await api.authenticated(
            "/v1/ai/memories",
            method: .post,
            body: CreateAiMemoryRequest(category: category, content: content)
        )
        return response.memory
    }

    func deleteMemory(id: UUID) async throws {
        try await api.authenticatedVoid(
            "/v1/ai/memories/\(id.uuidString.lowercased())",
            method: .delete
        )
    }

    func forgetAll() async throws {
        try await api.authenticatedVoid("/v1/ai/memories", method: .delete)
    }

    func currentSession() async throws -> AiSession? {
        let response: AiSessionResponse = try await api.authenticated(
            "/v1/ai/sessions/current"
        )
        return response.session
    }

    func voiceTicket(id: UUID) async throws -> AiVoiceTicket {
        try await api.authenticated(
            "/v1/ai/sessions/\(id.uuidString.lowercased())/voice-ticket",
            method: .post
        )
    }

    func startSession() async throws -> AiSession? {
        let response: AiSessionResponse = try await api.authenticated(
            "/v1/ai/sessions",
            method: .post
        )
        return response.session
    }

    func markIdentityAnnounced(id: UUID) async throws -> AiSession? {
        let response: AiSessionResponse = try await api.authenticated(
            "/v1/ai/sessions/\(id.uuidString.lowercased())/identity-announced",
            method: .post
        )
        return response.session
    }

    func endSession(id: UUID) async throws -> AiSession? {
        let response: AiSessionResponse = try await api.authenticated(
            "/v1/ai/sessions/\(id.uuidString.lowercased())/end",
            method: .post
        )
        return response.session
    }
}

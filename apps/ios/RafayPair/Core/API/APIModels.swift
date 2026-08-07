import Foundation

struct User: Codable, Equatable, Identifiable, Sendable {
    let id: UUID
    let email: String
    let displayName: String
    let createdAt: Date
}

struct CurrentUserResponse: Codable, Sendable {
    let user: User
}

/// Native session credentials. The API omits these values for the Web cookie flow,
/// but they are mandatory for an iOS response and are persisted only in Keychain.
struct TokenPair: Codable, Equatable, Sendable {
    let accessToken: String
    let refreshToken: String
    let accessTokenExpiresAt: Date
    let refreshTokenExpiresAt: Date
}

struct AuthResponse: Codable, Sendable {
    let user: User
    let session: TokenPair
}

struct RegisterRequest: Codable, Sendable {
    let email: String
    let password: String
    let displayName: String
}

struct LoginRequest: Codable, Sendable {
    let email: String
    let password: String
}

struct RefreshRequest: Codable, Sendable {
    let refreshToken: String
}

enum PairStatus: String, Codable, Sendable {
    case waiting
    case active
}

struct PairMember: Codable, Equatable, Identifiable, Sendable {
    let userId: UUID
    let displayName: String
    let joinedAt: Date

    var id: UUID { userId }
}

struct PairSummary: Codable, Equatable, Identifiable, Sendable {
    let id: UUID
    let status: PairStatus
    let members: [PairMember]
    let joinCode: String?
    let createdAt: Date
}

struct PairResponse: Codable, Sendable {
    let pair: PairSummary
}

struct JoinPairRequest: Codable, Sendable {
    let code: String
}

enum ConsentScope: String, Codable, CaseIterable, Identifiable, Sendable {
    case careRequests = "care_requests"
    case presence
    case workoutProgress = "workout_progress"
    case pulseSnapshots = "pulse_snapshots"
    case breathingState = "breathing_state"
    case estimatedCalories = "estimated_calories"
    case aiPartnerContext = "ai_partner_context"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .careRequests: "Care requests"
        case .presence: "Presence"
        case .workoutProgress: "Workout progress"
        case .pulseSnapshots: "Pulse snapshots"
        case .breathingState: "Breathing sessions"
        case .estimatedCalories: "Estimated calories"
        case .aiPartnerContext: "AI partner context"
        }
    }

    var explanation: String {
        switch self {
        case .careRequests: "Allow your partner to send check-ins and care prompts."
        case .presence: "Share whether you are currently available in RafayPair."
        case .workoutProgress: "Share derived exercise progress, never camera frames."
        case .pulseSnapshots: "Share only a pulse estimate you explicitly approve."
        case .breathingState: "Share the state of an explicitly started breathing session."
        case .estimatedCalories: "Share clearly labeled workout calorie estimates."
        case .aiPartnerContext: "Allow approved partner context in a disclosed AI session."
        }
    }
}

struct ConsentGrant: Codable, Equatable, Identifiable, Sendable {
    let capability: ConsentScope
    let granted: Bool
    let updatedAt: Date

    var id: ConsentScope { capability }
    var scope: ConsentScope { capability }
    var enabled: Bool { granted }
}

struct ConsentListResponse: Codable, Sendable {
    let pairId: UUID
    let grantorUserId: UUID
    let granteeUserId: UUID
    let grants: [ConsentGrant]
}

struct ConsentMutation: Codable, Sendable {
    let capability: ConsentScope
    let granted: Bool
}

struct UpdateConsentRequest: Codable, Sendable {
    let grants: [ConsentMutation]
}

enum CareRequestKind: String, Codable, CaseIterable, Identifiable, Sendable {
    case checkIn = "check_in"
    case encouragement
    case breatheTogether = "breathe_together"
    case moveTogether = "move_together"
    case help
    case callMe = "call_me"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .checkIn: "Check in"
        case .encouragement: "Encouragement"
        case .breatheTogether: "Breathe together"
        case .moveTogether: "Move together"
        case .help: "I need help"
        case .callMe: "Call me"
        }
    }
}

enum CareRequestStatus: String, Codable, Sendable {
    case pending
    case accepted
    case declined
    case expired
}

enum CareResponse: String, Codable, Sendable {
    case accepted
    case declined
}

struct CareRequest: Codable, Equatable, Identifiable, Sendable {
    let id: UUID
    let clientRequestId: UUID
    let pairId: UUID
    let senderUserId: UUID
    let recipientUserId: UUID
    let kind: CareRequestKind
    let message: String?
    let status: CareRequestStatus
    let createdAt: Date
    let respondedAt: Date?
}

struct CareRequestResponse: Codable, Sendable {
    let careRequest: CareRequest
}

struct CareRequestListResponse: Codable, Sendable {
    let items: [CareRequest]
    let nextCursor: String?
}

struct CreateCareRequest: Codable, Sendable {
    let clientRequestId: UUID
    let kind: CareRequestKind
    let message: String?
}

struct RespondToCareRequest: Codable, Sendable {
    let response: CareResponse
}

struct PrivacyState: Codable, Equatable, Sendable {
    let pairId: UUID?
    let userId: UUID?
    let paused: Bool
    let pausedAt: Date?
    let updatedAt: Date
}

struct PrivacyStateResponse: Codable, Sendable {
    let privacy: PrivacyState
}

struct RealtimeTicketRequest: Codable, Sendable {
    let lastEventId: String?
}

struct RealtimeTicket: Codable, Sendable {
    let ticket: String
    let expiresAt: Date
    let webSocketUrl: URL
}

struct RealtimeEnvelope<Payload: Codable & Sendable>: Codable, Sendable {
    let version: Int
    let id: UUID
    let eventId: String
    let authorizationRevision: String
    let type: String
    let occurredAt: Date
    let pairId: UUID
    let payload: Payload
}

enum NotificationPlatform: String, Codable, Sendable {
    case ios
    case android
}

struct RegisterNotificationDeviceRequest: Codable, Sendable {
    let platform: NotificationPlatform
    let token: String
    let installationId: UUID
}

struct NotificationDevice: Codable, Equatable, Identifiable, Sendable {
    let id: UUID
    let platform: NotificationPlatform
    let createdAt: Date
    let updatedAt: Date
    let expiresAt: Date
}

struct NotificationDeviceResponse: Codable, Sendable {
    let device: NotificationDevice
}

struct ProblemDetails: Codable, Equatable, Sendable {
    let type: String?
    let title: String
    let status: Int
    let detail: String?
    let instance: String?
    let code: String?
}

struct EmptyResponse: Codable, Sendable {}

// MARK: - Together mode

/// Master specification §10: each phone detects its own user and exchanges only
/// derived state. There is no field here for a frame, a landmark, or an audio
/// sample, so none can be transmitted.
enum TogetherActivity: String, Codable, Sendable, CaseIterable {
    case squat
    case bodyweightMixed
    case guidedBreathing
}

enum TogetherSessionStatus: String, Codable, Sendable {
    case invited
    case active
    case declined
    case ended
    case expired
}

enum TogetherExercisePhase: String, Codable, Sendable {
    case idle
    case descending
    case bottom
    case resting
    case complete
}

struct TogetherParticipantState: Codable, Sendable, Identifiable {
    let userId: UUID
    let repetitions: Int
    let exercisePhase: TogetherExercisePhase
    let setIndex: Int
    let elapsedMs: Int
    let estimatedKcal: Double?
    let breathingState: String?
    let updatedAt: Date

    var id: UUID { userId }
}

struct TogetherSession: Codable, Sendable, Identifiable {
    let id: UUID
    let pairId: UUID
    let invitedByUserId: UUID
    let invitedUserId: UUID
    let activity: TogetherActivity
    let status: TogetherSessionStatus
    let createdAt: Date
    let acceptedAt: Date?
    let endedAt: Date?
    let expiresAt: Date
    let participants: [TogetherParticipantState]
}

struct TogetherSessionResponse: Codable, Sendable {
    let session: TogetherSession?
}

struct CreateTogetherSessionRequest: Codable, Sendable {
    let activity: TogetherActivity
}

struct RespondTogetherSessionRequest: Codable, Sendable {
    let response: String
}

struct PublishTogetherStateRequest: Codable, Sendable {
    let repetitions: Int
    let exercisePhase: TogetherExercisePhase
    let setIndex: Int
    let elapsedMs: Int
    let estimatedKcal: Double?
    let breathingState: String?
}

// MARK: - Rafay AI

enum AiMemoryCategory: String, Codable, Sendable, CaseIterable {
    case preference
    case routine
    case boundary
    case context
}

struct AiMemory: Codable, Sendable, Identifiable {
    let id: UUID
    let category: AiMemoryCategory
    let content: String
    /// `assistant` entries were proposed by the model rather than stated by the
    /// user, and are shown as such.
    let author: String
    let createdAt: Date
    let updatedAt: Date
}

struct AiMemoryListResponse: Codable, Sendable {
    let memories: [AiMemory]
    let limit: Int
}

struct AiMemoryResponse: Codable, Sendable {
    let memory: AiMemory
}

struct CreateAiMemoryRequest: Codable, Sendable {
    let category: AiMemoryCategory
    let content: String
}

struct AiAllowedTool: Codable, Sendable, Identifiable {
    let name: String
    let title: String
    let mutating: Bool
    let requiresConfirmation: Bool

    var id: String { name }
}

struct AiSession: Codable, Sendable, Identifiable {
    let id: UUID
    let status: String
    let startedAt: Date
    let expiresAt: Date
    let endedAt: Date?
    let identityAnnounced: Bool
    /// Server-supplied so a client cannot quietly drop or reword it.
    let identityDisclosure: String
    let allowedTools: [AiAllowedTool]
}

struct AiVoiceAudioFormat: Codable, Sendable {
    let encoding: String
    let sampleRateHz: Int
    /// Generated speech comes back at a higher rate than capture. Playing it at
    /// the capture rate would pitch the assistant's voice down.
    let outputSampleRateHz: Int
    let channels: Int
}

/// The socket ticket. Server-stated audio format: the client conforms rather
/// than negotiating, so there is one framing to get right instead of many.
struct AiVoiceTicket: Codable, Sendable {
    let ticket: String
    let expiresAt: Date
    let webSocketUrl: URL
    let audio: AiVoiceAudioFormat
}

struct AiSessionResponse: Codable, Sendable {
    let session: AiSession?
}

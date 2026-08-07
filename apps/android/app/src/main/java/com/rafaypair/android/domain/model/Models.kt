package com.rafaypair.android.domain.model

import java.time.Instant

data class User(
    val id: String,
    val email: String,
    val displayName: String,
)

data class AuthTokens(
    val accessToken: String,
    val refreshToken: String,
    val accessTokenExpiresAt: Instant,
    val refreshTokenExpiresAt: Instant,
    val userId: String,
)

sealed interface SessionState {
    data object Restoring : SessionState
    data object SignedOut : SessionState
    data class SignedIn(val user: User) : SessionState
}

enum class PairStatus {
    WAITING_FOR_PARTNER,
    ACTIVE,
}

data class Partner(
    val id: String,
    val displayName: String,
)

data class PairDetails(
    val id: String,
    val status: PairStatus,
    val joinCode: String?,
    val partner: Partner?,
    val createdAt: Instant,
)

enum class ConsentCapability(val title: String, val description: String) {
    CARE_REQUESTS(
        title = "Care requests",
        description = "Let your partner send you check-ins and support requests.",
    ),
    PRESENCE(
        title = "Presence",
        description = "Share whether you are available in RafayPair. Never shares precise location.",
    ),
    WORKOUT_PROGRESS(
        title = "Workout progress",
        description = "Share derived exercise progress such as reps and elapsed time.",
    ),
    PULSE_SNAPSHOTS(
        title = "Pulse snapshots",
        description = "Allow explicitly approved, provenance-labelled pulse estimates to be shared.",
    ),
    BREATHING_STATE(
        title = "Breathing state",
        description = "Share derived breathing-session state, never microphone or camera recordings.",
    ),
    ESTIMATED_CALORIES(
        title = "Estimated calories",
        description = "Share clearly labelled calorie estimates from a workout.",
    ),
    AI_PARTNER_CONTEXT(
        title = "AI partner context",
        description = "Let Rafay use the partner context you approve. This never overrides another consent.",
    ),
}

data class ConsentGrant(
    val capability: ConsentCapability,
    val granted: Boolean,
    val updatedAt: Instant?,
)

enum class CareKind(val title: String, val prompt: String) {
    CHECK_IN("Check in", "How are you doing?"),
    ENCOURAGEMENT("Encouragement", "You’ve got this."),
    BREATHE_TOGETHER("Breathe together", "Want to take a calm breathing break together?"),
    MOVE_TOGETHER("Move together", "Want to move together for a few minutes?"),
    HELP("Need support", "I could use your support."),
    CALL_ME("Call me", "Can you call when you’re free?"),
}

enum class CareResponse(val label: String) {
    ACCEPTED("Accept"),
    DECLINED("Decline"),
}

enum class CareDirection {
    SENT,
    RECEIVED,
}

enum class CareDeliveryStatus {
    DRAFT,
    QUEUED,
    SENT,
    ACCEPTED,
    DECLINED,
    FAILED,
    BLOCKED,
}

data class CareItem(
    val id: String,
    val clientRequestId: String?,
    val kind: CareKind,
    val message: String?,
    val direction: CareDirection,
    val status: CareDeliveryStatus,
    val otherDisplayName: String?,
    val createdAt: Instant,
    val respondedAt: Instant?,
)

data class PrivacyState(
    val ownerUserId: String? = null,
    val pairId: String? = null,
    val isPaused: Boolean = true,
    val desiredPaused: Boolean = true,
    val syncPending: Boolean = false,
    val boundaryReady: Boolean = false,
) {
    fun allowsSharing(ownerUserId: String, pairId: String): Boolean =
        boundaryReady &&
            this.ownerUserId == ownerUserId &&
            this.pairId == pairId &&
            !isPaused &&
            !syncPending
}

enum class RealtimeState {
    STOPPED,
    CONNECTING,
    CONNECTED,
    RECOVERING,
}

data class RepositoryFailure(
    val title: String,
    override val message: String,
    val status: Int? = null,
    val code: String? = null,
) : Exception(message)

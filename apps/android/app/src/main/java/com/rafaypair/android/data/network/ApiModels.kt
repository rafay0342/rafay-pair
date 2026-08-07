package com.rafaypair.android.data.network

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
data class UserDto(
    val id: String,
    val email: String,
    val displayName: String,
    val createdAt: String,
)

@Serializable
data class SessionDto(
    val accessToken: String? = null,
    val refreshToken: String? = null,
    val accessTokenExpiresAt: String,
    val refreshTokenExpiresAt: String,
)

@Serializable
data class AuthResponseDto(val user: UserDto, val session: SessionDto)

@Serializable
data class RegisterRequestDto(val email: String, val password: String, val displayName: String)

@Serializable
data class LoginRequestDto(val email: String, val password: String)

@Serializable
data class RefreshRequestDto(val refreshToken: String? = null)

@Serializable
data class LogoutRequestDto(val refreshToken: String? = null)

@Serializable
data class PairMemberDto(
    val userId: String,
    val displayName: String,
    val joinedAt: String,
)

@Serializable
data class PairDto(
    val id: String,
    val status: String,
    val members: List<PairMemberDto>,
    val joinCode: String? = null,
    val createdAt: String,
)

@Serializable
data class PairResponseDto(val pair: PairDto)

@Serializable
data class JoinPairRequestDto(val code: String)

@Serializable
data class ConsentGrantDto(
    val capability: String,
    val granted: Boolean,
    val updatedAt: String,
)

@Serializable
data class ConsentResponseDto(
    val pairId: String,
    val grantorUserId: String,
    val granteeUserId: String,
    val grants: List<ConsentGrantDto>,
)

@Serializable
data class ConsentUpdateDto(val capability: String, val granted: Boolean)

@Serializable
data class UpdateConsentsRequestDto(val grants: List<ConsentUpdateDto>)

@Serializable
data class CreateCareRequestDto(
    val clientRequestId: String,
    val kind: String,
    val message: String? = null,
)

@Serializable
data class CareRequestDto(
    val id: String,
    val clientRequestId: String,
    val pairId: String,
    val senderUserId: String,
    val recipientUserId: String,
    val kind: String,
    val message: String? = null,
    val status: String,
    val createdAt: String,
    val respondedAt: String? = null,
)

@Serializable
data class CareRequestResponseDto(val careRequest: CareRequestDto)

@Serializable
data class CareRequestListResponseDto(
    val items: List<CareRequestDto>,
    val nextCursor: String? = null,
)

@Serializable
data class RegisterNotificationDeviceRequestDto(
    val platform: String,
    val token: String,
    val installationId: String,
)

@Serializable
data class NotificationDeviceDto(
    val id: String,
    val platform: String,
    val createdAt: String,
    val updatedAt: String,
    val expiresAt: String,
)

@Serializable
data class NotificationDeviceResponseDto(val device: NotificationDeviceDto)

@Serializable
data class AndroidIntegrityChallengeRequestDto(val action: String)

@Serializable
data class AndroidIntegrityChallengeDto(
    val id: String,
    val action: String,
    val bindingVersion: String,
    val expiresAt: String,
)

@Serializable
data class AndroidIntegrityChallengeResponseDto(val challenge: AndroidIntegrityChallengeDto)

@Serializable
data class AndroidIntegrityAssessmentRequestDto(
    val challengeId: String,
    val action: String,
    val integrityToken: String,
)

@Serializable
data class AndroidIntegrityAssessmentDto(
    val id: String,
    val signal: String,
    val evaluatedAt: String,
)

@Serializable
data class AndroidIntegrityAssessmentResponseDto(val assessment: AndroidIntegrityAssessmentDto)

@Serializable
data class RespondCareRequestDto(val response: String)

@Serializable
data class PrivacyDto(
    val pairId: String,
    val userId: String,
    val paused: Boolean,
    val pausedAt: String? = null,
    val updatedAt: String,
)

@Serializable
data class PrivacyResponseDto(val privacy: PrivacyDto)

@Serializable
class EmptyRequestDto

@Serializable
data class RealtimeTicketRequestDto(val lastEventId: String? = null)

@Serializable
data class RealtimeTicketResponseDto(
    val ticket: String,
    val expiresAt: String,
    val webSocketUrl: String,
)

@Serializable
data class RealtimeEnvelopeDto(
    val version: Int,
    val id: String,
    val eventId: String,
    val authorizationRevision: String,
    val type: String,
    val occurredAt: String,
    val pairId: String,
    val payload: JsonObject,
)

@Serializable
data class ProblemDetailsDto(
    val type: String = "about:blank",
    val title: String = "Request failed",
    val status: Int,
    val detail: String? = null,
    val instance: String? = null,
    val code: String,
    val requestId: String? = null,
    val errors: Map<String, List<String>>? = null,
)

internal fun String.toApiWireValue(): String = lowercase()

internal fun String.fromApiStatus(): String = when (this) {
    "waiting" -> "WAITING_FOR_PARTNER"
    "active" -> "ACTIVE"
    else -> uppercase()
}

// MARK: - Together mode

/**
 * Master specification §10: each phone detects its own user and exchanges only
 * derived state. There is no field here for a frame, a landmark, or an audio
 * sample, so none can be transmitted.
 */
@Serializable
data class TogetherParticipantStateDto(
    val userId: String,
    val repetitions: Int,
    val exercisePhase: String,
    val setIndex: Int,
    val elapsedMs: Int,
    val estimatedKcal: Double? = null,
    val breathingState: String? = null,
    val updatedAt: String,
)

@Serializable
data class TogetherSessionDto(
    val id: String,
    val pairId: String,
    val invitedByUserId: String,
    val invitedUserId: String,
    val activity: String,
    val status: String,
    val createdAt: String,
    val acceptedAt: String? = null,
    val endedAt: String? = null,
    val expiresAt: String,
    val participants: List<TogetherParticipantStateDto> = emptyList(),
)

@Serializable
data class TogetherSessionResponseDto(val session: TogetherSessionDto? = null)

@Serializable
data class CreateTogetherSessionRequestDto(val activity: String)

@Serializable
data class RespondTogetherSessionRequestDto(val response: String)

@Serializable
data class PublishTogetherStateRequestDto(
    val repetitions: Int,
    val exercisePhase: String,
    val setIndex: Int,
    val elapsedMs: Int,
    val estimatedKcal: Double? = null,
    val breathingState: String? = null,
)

// MARK: - Rafay AI

@Serializable
data class AiMemoryDto(
    val id: String,
    val category: String,
    val content: String,
    /** `assistant` entries were proposed by the model rather than stated. */
    val author: String,
    val createdAt: String,
    val updatedAt: String,
)

@Serializable
data class AiMemoryListResponseDto(
    val memories: List<AiMemoryDto> = emptyList(),
    val limit: Int,
)

@Serializable
data class AiMemoryResponseDto(val memory: AiMemoryDto)

@Serializable
data class CreateAiMemoryRequestDto(val category: String, val content: String)

@Serializable
data class AiAllowedToolDto(
    val name: String,
    val title: String,
    val mutating: Boolean,
    val requiresConfirmation: Boolean,
)

@Serializable
data class AiSessionDto(
    val id: String,
    val status: String,
    val startedAt: String,
    val expiresAt: String,
    val endedAt: String? = null,
    val identityAnnounced: Boolean,
    /** Server-supplied so a client cannot quietly drop or reword it. */
    val identityDisclosure: String,
    val allowedTools: List<AiAllowedToolDto> = emptyList(),
)

@Serializable
data class AiSessionResponseDto(val session: AiSessionDto? = null)

@Serializable
data class AiVoiceAudioFormatDto(
    val encoding: String,
    val sampleRateHz: Int,
    /**
     * Generated speech comes back at a higher rate than capture. Playing it at
     * the capture rate would pitch the assistant's voice down.
     */
    val outputSampleRateHz: Int,
    val channels: Int,
)

/**
 * The socket ticket. The audio format is server-stated: the client conforms
 * rather than negotiating, so there is one framing to get right instead of many.
 */
@Serializable
data class AiVoiceTicketDto(
    val ticket: String,
    val expiresAt: String,
    val webSocketUrl: String,
    val audio: AiVoiceAudioFormatDto,
)

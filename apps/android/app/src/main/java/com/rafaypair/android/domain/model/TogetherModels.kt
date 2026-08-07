package com.rafaypair.android.domain.model

/**
 * Together mode and the assistant, as the app understands them.
 *
 * Master specification §10: both phones detect their own user and exchange only
 * derived session state. There is no property in this file that could hold a
 * frame, a landmark, or an audio sample, so none can travel between partners.
 */

enum class TogetherActivity(val wireValue: String, val label: String) {
    SQUAT("squat", "Squats together"),
    BODYWEIGHT_MIXED("bodyweightMixed", "Mixed bodyweight together"),
    GUIDED_BREATHING("guidedBreathing", "Breathing together"),
    ;

    companion object {
        fun fromWire(value: String): TogetherActivity? = entries.firstOrNull { it.wireValue == value }
    }
}

enum class TogetherStatus(val wireValue: String) {
    INVITED("invited"),
    ACTIVE("active"),
    DECLINED("declined"),
    ENDED("ended"),
    EXPIRED("expired"),
    ;

    companion object {
        fun fromWire(value: String): TogetherStatus? = entries.firstOrNull { it.wireValue == value }
    }
}

data class TogetherParticipantState(
    val userId: String,
    val repetitions: Int,
    val exercisePhase: String,
    val setIndex: Int,
    val elapsedMs: Int,
    val estimatedKcal: Double?,
    val breathingState: String?,
)

data class TogetherSession(
    val id: String,
    val invitedByUserId: String,
    val invitedUserId: String,
    val activity: TogetherActivity,
    val status: TogetherStatus,
    val participants: List<TogetherParticipantState>,
)

enum class AiMemoryCategory(val wireValue: String, val label: String) {
    PREFERENCE("preference", "Preference"),
    ROUTINE("routine", "Routine"),
    BOUNDARY("boundary", "Boundary"),
    CONTEXT("context", "Context"),
    ;

    companion object {
        fun fromWire(value: String): AiMemoryCategory? = entries.firstOrNull { it.wireValue == value }
    }
}

data class AiMemory(
    val id: String,
    val category: AiMemoryCategory,
    val content: String,
    /** `assistant` entries were proposed by the model rather than stated by the user. */
    val author: String,
)

data class AiMemoryPage(
    val memories: List<AiMemory>,
    val limit: Int,
)

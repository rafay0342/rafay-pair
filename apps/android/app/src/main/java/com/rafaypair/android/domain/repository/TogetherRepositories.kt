package com.rafaypair.android.domain.repository

import com.rafaypair.android.data.network.AiVoiceTicketDto
import com.rafaypair.android.domain.model.AiMemory
import com.rafaypair.android.domain.model.AiMemoryCategory
import com.rafaypair.android.domain.model.AiMemoryPage
import com.rafaypair.android.domain.model.AiSession
import com.rafaypair.android.domain.model.TogetherActivity
import com.rafaypair.android.domain.model.TogetherSession

interface TogetherRepository {
    /** `null` when there is no open session — a state, not a failure. */
    suspend fun current(): TogetherSession?
    suspend fun invite(activity: TogetherActivity): TogetherSession?
    suspend fun respond(id: String, accepted: Boolean): TogetherSession?
    suspend fun publishState(
        id: String,
        repetitions: Int,
        exercisePhase: String,
        setIndex: Int,
        elapsedMs: Int,
        estimatedKcal: Double? = null,
        breathingState: String? = null,
    ): TogetherSession?
    suspend fun end(id: String): TogetherSession?
}

interface AssistantRepository {
    suspend fun memories(): AiMemoryPage
    suspend fun addMemory(category: AiMemoryCategory, content: String): AiMemory
    suspend fun deleteMemory(id: String)
    suspend fun forgetAll()

    suspend fun currentSession(): AiSession?
    suspend fun startSession(): AiSession?
    suspend fun announceIdentity(id: String): AiSession?
    suspend fun endSession(id: String): AiSession?
    suspend fun voiceTicket(id: String): AiVoiceTicketDto
}

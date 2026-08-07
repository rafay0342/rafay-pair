package com.rafaypair.android.data.repository

import com.rafaypair.android.data.network.AiMemoryDto
import com.rafaypair.android.data.network.ApiClient
import com.rafaypair.android.data.network.ApiHttpException
import com.rafaypair.android.data.network.ApiNetworkException
import com.rafaypair.android.data.network.PublishTogetherStateRequestDto
import com.rafaypair.android.data.network.TogetherSessionDto
import com.rafaypair.android.domain.model.AiMemory
import com.rafaypair.android.domain.model.AiMemoryCategory
import com.rafaypair.android.domain.model.AiMemoryPage
import com.rafaypair.android.domain.model.RepositoryFailure
import com.rafaypair.android.domain.model.TogetherActivity
import com.rafaypair.android.domain.model.TogetherParticipantState
import com.rafaypair.android.domain.model.TogetherSession
import com.rafaypair.android.domain.model.TogetherStatus
import com.rafaypair.android.domain.repository.AssistantRepository
import com.rafaypair.android.domain.repository.TogetherRepository

class DefaultTogetherRepository(private val api: ApiClient) : TogetherRepository {
    override suspend fun current(): TogetherSession? = call {
        api.currentTogetherSession().session?.toDomain()
    }

    override suspend fun invite(activity: TogetherActivity): TogetherSession? = call {
        api.inviteTogetherSession(activity.wireValue).session?.toDomain()
    }

    override suspend fun respond(id: String, accepted: Boolean): TogetherSession? = call {
        api.respondTogetherSession(id, if (accepted) "accepted" else "declined").session?.toDomain()
    }

    override suspend fun publishState(
        id: String,
        repetitions: Int,
        exercisePhase: String,
        setIndex: Int,
        elapsedMs: Int,
        estimatedKcal: Double?,
        breathingState: String?,
    ): TogetherSession? = call {
        api.publishTogetherState(
            id,
            PublishTogetherStateRequestDto(
                repetitions = repetitions,
                exercisePhase = exercisePhase,
                setIndex = setIndex,
                elapsedMs = elapsedMs,
                estimatedKcal = estimatedKcal,
                breathingState = breathingState,
            ),
        ).session?.toDomain()
    }

    override suspend fun end(id: String): TogetherSession? = call {
        api.endTogetherSession(id).session?.toDomain()
    }

    /**
     * A pair that has ended, or a partner who paused sharing, answers 403/404.
     * Neither is an error to show: there is simply no session to display.
     */
    private suspend fun <T> call(block: suspend () -> T?): T? =
        try {
            block()
        } catch (error: ApiHttpException) {
            if (error.status == 403 || error.status == 404) null else throw error.asRepositoryFailure()
        } catch (error: ApiNetworkException) {
            throw RepositoryFailure(
                "You’re offline",
                error.message ?: "Check your connection and try again.",
            )
        }
}

class DefaultAssistantRepository(private val api: ApiClient) : AssistantRepository {
    override suspend fun memories(): AiMemoryPage = call {
        val response = api.aiMemories()
        AiMemoryPage(response.memories.mapNotNull { it.toDomain() }, response.limit)
    }

    override suspend fun addMemory(category: AiMemoryCategory, content: String): AiMemory = call {
        api.addAiMemory(category.wireValue, content).memory.toDomain()
            ?: throw RepositoryFailure("Not saved", "That entry could not be stored.")
    }

    override suspend fun deleteMemory(id: String) = call { api.deleteAiMemory(id) }

    override suspend fun forgetAll() = call { api.forgetAllAiMemories() }

    private suspend fun <T> call(block: suspend () -> T): T =
        try {
            block()
        } catch (error: ApiHttpException) {
            throw error.asRepositoryFailure()
        } catch (error: ApiNetworkException) {
            throw RepositoryFailure(
                "You’re offline",
                error.message ?: "Check your connection and try again.",
            )
        }
}

internal fun TogetherSessionDto.toDomain(): TogetherSession? {
    // An activity or status this build does not know is dropped rather than
    // guessed at: showing the wrong shared state is worse than showing none.
    val knownActivity = TogetherActivity.fromWire(activity) ?: return null
    val knownStatus = TogetherStatus.fromWire(status) ?: return null
    return TogetherSession(
        id = id,
        invitedByUserId = invitedByUserId,
        invitedUserId = invitedUserId,
        activity = knownActivity,
        status = knownStatus,
        participants = participants.map {
            TogetherParticipantState(
                userId = it.userId,
                repetitions = it.repetitions,
                exercisePhase = it.exercisePhase,
                setIndex = it.setIndex,
                elapsedMs = it.elapsedMs,
                estimatedKcal = it.estimatedKcal,
                breathingState = it.breathingState,
            )
        },
    )
}

internal fun AiMemoryDto.toDomain(): AiMemory? {
    val known = AiMemoryCategory.fromWire(category) ?: return null
    return AiMemory(id = id, category = known, content = content, author = author)
}

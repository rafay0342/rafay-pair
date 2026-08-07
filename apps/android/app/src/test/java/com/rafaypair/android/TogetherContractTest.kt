package com.rafaypair.android

import com.rafaypair.android.data.network.AiMemoryListResponseDto
import com.rafaypair.android.data.network.TogetherParticipantStateDto
import com.rafaypair.android.data.network.TogetherSessionResponseDto
import com.rafaypair.android.data.repository.toDomain
import com.rafaypair.android.domain.model.AiMemoryCategory
import com.rafaypair.android.domain.model.TogetherActivity
import com.rafaypair.android.domain.model.TogetherStatus
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Together mode and the assistant, checked against the wire contract.
 *
 * Master specification §10: partners exchange derived state only. The structural
 * test below is the one that matters — a field that could carry a frame, a
 * landmark, or an audio sample would make every policy check downstream
 * advisory.
 */
class TogetherContractTest {
    private val json = Json { ignoreUnknownKeys = true }

    private val sessionBody =
        """
        {
          "session": {
            "id": "3f2b7b9e-4b0f-4a5b-9d2f-7a1c2d3e4f50",
            "pairId": "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
            "invitedByUserId": "58b78358-88f5-4b6e-a337-c729750f179f",
            "invitedUserId": "0b2c1a3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
            "activity": "squat",
            "status": "active",
            "createdAt": "2026-08-07T00:00:00Z",
            "acceptedAt": "2026-08-07T00:00:05Z",
            "expiresAt": "2026-08-07T01:00:00Z",
            "participants": [
              {
                "userId": "58b78358-88f5-4b6e-a337-c729750f179f",
                "repetitions": 12,
                "exercisePhase": "descending",
                "setIndex": 1,
                "elapsedMs": 64000,
                "estimatedKcal": 18.5,
                "breathingState": "exhale",
                "updatedAt": "2026-08-07T00:01:04Z"
              }
            ]
          }
        }
        """.trimIndent()

    @Test
    fun `together session decodes into derived state only`() {
        val session = json.decodeFromString<TogetherSessionResponseDto>(sessionBody).session
        assertNotNull(session)
        val domain = session!!.toDomain()
        assertNotNull(domain)
        assertEquals(TogetherActivity.SQUAT, domain!!.activity)
        assertEquals(TogetherStatus.ACTIVE, domain.status)
        assertEquals(1, domain.participants.size)
        assertEquals(12, domain.participants[0].repetitions)
        assertEquals("exhale", domain.participants[0].breathingState)
    }

    @Test
    fun `participant state carries no media field`() {
        // Enumerating the declared properties makes the guarantee structural: a
        // new field named for a frame, landmark, or audio buffer fails here
        // before it can ever be serialized to a partner.
        val forbidden = listOf("frame", "image", "landmark", "pose", "audio", "pcm", "sample", "video")
        val declared = TogetherParticipantStateDto::class.java.declaredFields.map { it.name.lowercase() }
        forbidden.forEach { word ->
            assertTrue(
                "TogetherParticipantStateDto must not declare a field containing '$word'",
                declared.none { it.contains(word) },
            )
        }
    }

    @Test
    fun `an activity this build does not know is dropped rather than guessed`() {
        val unknown = sessionBody.replace("\"activity\": \"squat\"", "\"activity\": \"kettlebell\"")
        val session = json.decodeFromString<TogetherSessionResponseDto>(unknown).session
        assertNotNull(session)
        assertNull(session!!.toDomain())
    }

    @Test
    fun `assistant memories keep the author that proposed them`() {
        val body =
            """
            {
              "memories": [
                {
                  "id": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
                  "category": "preference",
                  "content": "I prefer to train in the evening",
                  "author": "assistant",
                  "createdAt": "2026-08-07T00:00:00Z",
                  "updatedAt": "2026-08-07T00:00:00Z"
                }
              ],
              "limit": 50
            }
            """.trimIndent()
        val page = json.decodeFromString<AiMemoryListResponseDto>(body)
        val memory = page.memories.single().toDomain()
        assertNotNull(memory)
        assertEquals(AiMemoryCategory.PREFERENCE, memory!!.category)
        // The origin of an entry is preserved so the interface can mark which of
        // these the user said and which the model inferred.
        assertEquals("assistant", memory.author)
        assertEquals(50, page.limit)
    }
}

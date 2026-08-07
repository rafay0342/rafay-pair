package com.rafaypair.android

import com.rafaypair.android.data.network.AuthResponseDto
import com.rafaypair.android.data.network.CareRequestListResponseDto
import com.rafaypair.android.data.network.ConsentResponseDto
import com.rafaypair.android.data.network.RealtimeEnvelopeDto
import com.rafaypair.android.data.network.NotificationDeviceResponseDto
import com.rafaypair.android.data.network.RegisterNotificationDeviceRequestDto
import com.rafaypair.android.data.network.realtimeProtocolHeader
import com.rafaypair.android.data.network.toDomainTokens
import com.rafaypair.android.data.network.validatedRealtimeSocketUrl
import com.rafaypair.android.domain.model.ConsentCapability
import java.time.Instant
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ApiContractTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `mobile auth response requires and maps rotating token pair`() {
        val response = json.decodeFromString<AuthResponseDto>(
            """
            {
              "user": {
                "id": "58b78358-88f5-4b6e-a337-c729750f179f",
                "email": "rafay@example.com",
                "displayName": "Rafay",
                "createdAt": "2026-08-07T00:00:00Z"
              },
              "session": {
                "accessToken": "access-token-value",
                "refreshToken": "refresh-token-value-that-is-long-enough",
                "accessTokenExpiresAt": "2026-08-07T00:15:00Z",
                "refreshTokenExpiresAt": "2026-09-06T00:00:00Z"
              }
            }
            """.trimIndent(),
        )

        val tokens = response.toDomainTokens()
        assertEquals("58b78358-88f5-4b6e-a337-c729750f179f", tokens.userId)
        assertEquals(Instant.parse("2026-08-07T00:15:00Z"), tokens.accessTokenExpiresAt)
        assertEquals("refresh-token-value-that-is-long-enough", tokens.refreshToken)
    }

    @Test
    fun `consent contract contains every default-deny capability`() {
        val grants = ConsentCapability.entries.joinToString(",") { capability ->
            """{"capability":"${capability.name.lowercase()}","granted":false,"updatedAt":"2026-08-07T00:00:00Z"}"""
        }
        val response = json.decodeFromString<ConsentResponseDto>(
            """{
              "pairId":"58b78358-88f5-4b6e-a337-c729750f179f",
              "grantorUserId":"db63bd89-2168-457a-86db-bb61512189a0",
              "granteeUserId":"016bbc8e-8867-4c06-9fb0-d3d30e842137",
              "grants":[$grants]
            }""",
        )

        assertEquals(ConsentCapability.entries.size, response.grants.size)
        assertTrue(response.grants.none { it.granted })
    }

    @Test
    fun `care and realtime envelopes decode canonical API fixtures`() {
        val care = json.decodeFromString<CareRequestListResponseDto>(
            """{
              "items":[{
                "id":"58b78358-88f5-4b6e-a337-c729750f179f",
                "clientRequestId":"db63bd89-2168-457a-86db-bb61512189a0",
                "pairId":"016bbc8e-8867-4c06-9fb0-d3d30e842137",
                "senderUserId":"16ff842d-600e-46cf-a63a-842b37b1b6b1",
                "recipientUserId":"90dad94e-a09a-4410-9d5b-b3ac0091c773",
                "kind":"breathe_together",
                "status":"pending",
                "createdAt":"2026-08-07T00:00:00Z"
              }]
            }""",
        )
        val event = json.decodeFromString<RealtimeEnvelopeDto>(
            """{
              "version":1,
              "id":"58b78358-88f5-4b6e-a337-c729750f179f",
              "eventId":"42",
              "authorizationRevision":"7",
              "type":"care.request.created",
              "occurredAt":"2026-08-07T00:00:00Z",
              "pairId":"016bbc8e-8867-4c06-9fb0-d3d30e842137",
              "payload":{}
            }""",
        )

        assertEquals("breathe_together", care.items.single().kind)
        assertEquals(1, event.version)
        assertEquals("42", event.eventId)
    }

    @Test
    fun `realtime ticket is carried only in the websocket protocol header`() {
        val ticket = "a".repeat(43)
        val url = validatedRealtimeSocketUrl(
            "wss://api.rafaypair.com/v1/realtime",
            "https://api.rafaypair.com",
        )

        assertEquals("wss://api.rafaypair.com/v1/realtime", url)
        assertEquals(
            "rafaypair.v1, rafaypair.ticket.$ticket",
            realtimeProtocolHeader(ticket),
        )
        assertTrue(!url.contains(ticket))
        assertTrue(
            runCatching {
                validatedRealtimeSocketUrl(
                    "wss://attacker.example/v1/realtime",
                    "https://api.rafaypair.com",
                )
            }.isFailure,
        )
    }

    @Test
    fun `notification device contract includes stable installation id`() {
        val request = RegisterNotificationDeviceRequestDto(
            platform = "android",
            token = "cdefghijklmnopqrstuvwxyz123456",
            installationId = "00000000-0000-4000-8000-000000000099",
        )
        val encoded = json.encodeToString(RegisterNotificationDeviceRequestDto.serializer(), request)
        val response = json.decodeFromString<NotificationDeviceResponseDto>(
            """{
              "device": {
                "id":"00000000-0000-4000-8000-000000000098",
                "platform":"android",
                "createdAt":"2026-08-07T00:00:00Z",
                "updatedAt":"2026-08-07T00:00:00Z",
                "expiresAt":"2026-11-05T00:00:00Z"
              }
            }""",
        )

        assertTrue(encoded.contains("\"installationId\""))
        assertTrue(!encoded.contains("installation_id"))
        assertEquals("android", response.device.platform)
    }
}

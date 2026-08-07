package com.rafaypair.android

import com.rafaypair.android.data.network.VoiceEvent
import com.rafaypair.android.data.network.VoiceToolConfirmation
import com.rafaypair.android.data.network.decodeVoiceFrame
import com.rafaypair.android.data.network.validatedVoiceSocketUrl
import com.rafaypair.android.data.network.voiceProtocolHeader
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * The voice socket's handshake and wire protocol.
 *
 * Both are checked here rather than only against a running server, because the
 * failures they prevent — a microphone opened against the wrong host, a tool
 * confirmation misread — are not the kind that surface as a flaky test.
 */
class VoiceClientTest {
    private val json = Json { ignoreUnknownKeys = true }
    private val ticket = "a".repeat(43)
    private val apiBase = "https://api.example.test"

    @Test
    fun `carries the ticket in the protocol header rather than the URL`() {
        assertEquals(
            "rafaypair.voice.v1, rafaypair.ticket.$ticket",
            voiceProtocolHeader(ticket),
        )
        assertEquals(
            "wss://api.example.test/v1/ai/voice",
            validatedVoiceSocketUrl("wss://api.example.test/v1/ai/voice", apiBase),
        )
    }

    @Test
    fun `refuses a socket that is not the configured API`() {
        // A redirected socket would carry a live microphone wherever it pointed.
        listOf(
            "wss://elsewhere.example.test/v1/ai/voice",
            "wss://api.example.test:8443/v1/ai/voice",
            "wss://api.example.test/v1/realtime",
            "wss://api.example.test/v1/ai/voice?ticket=leak",
            "wss://user:pass@api.example.test/v1/ai/voice",
        ).forEach { url ->
            assertThrows(IllegalArgumentException::class.java) {
                validatedVoiceSocketUrl(url, apiBase)
            }
        }
    }

    @Test
    fun `refuses a ticket of the wrong shape`() {
        listOf("", "short", "a".repeat(44), "has spaces!!").forEach { value ->
            assertThrows(IllegalArgumentException::class.java) { voiceProtocolHeader(value) }
        }
    }

    @Test
    fun `decodes the server frames the protocol defines`() {
        assertEquals(VoiceEvent.Ready, decodeVoiceFrame(json, """{"type":"ready"}"""))
        assertEquals(
            VoiceEvent.Transcript("hello", true),
            decodeVoiceFrame(json, """{"type":"transcript","text":"hello","final":true}"""),
        )
        assertEquals(
            VoiceEvent.ConfirmationRequested(
                VoiceToolConfirmation("c1", "remember", "Save it"),
            ),
            decodeVoiceFrame(
                json,
                """{"type":"tool_confirmation","callId":"c1","name":"remember","title":"Save it"}""",
            ),
        )
        assertEquals(
            VoiceEvent.ToolSettled("c1", "executed"),
            decodeVoiceFrame(json, """{"type":"tool_result","callId":"c1","decision":"executed"}"""),
        )
        assertEquals(
            VoiceEvent.Closed("user_ended"),
            decodeVoiceFrame(json, """{"type":"closed","reason":"user_ended"}"""),
        )
    }

    @Test
    fun `ignores frames it does not understand`() {
        // Including a confirmation without a call id: acting on one would mean
        // prompting the user to authorize something unidentifiable.
        listOf(
            "not json",
            """{"type":"tool_confirmation","name":"remember"}""",
            """{"type":"transcript","final":true}""",
            """{"type":"execute","name":"remember"}""",
            "[]",
        ).forEach { raw ->
            assertNull(raw, decodeVoiceFrame(json, raw))
        }
    }
}

package com.rafaypair.android.data.network

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import com.rafaypair.android.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

/**
 * The AI voice socket.
 *
 * Audio goes to the RafayPair server, never to a provider directly: the server
 * holds the credential, composes the instructions, and is the only thing that
 * may authorize a tool call. A client that talked to the provider itself would
 * have to be trusted with all three.
 */
internal const val VOICE_APPLICATION_PROTOCOL = "rafaypair.voice.v1"

internal fun voiceProtocolHeader(ticket: String): String {
    require(Regex("^[A-Za-z0-9_-]{43}$").matches(ticket)) { "Invalid voice ticket" }
    return "$VOICE_APPLICATION_PROTOCOL, $REALTIME_TICKET_PROTOCOL_PREFIX$ticket"
}

/**
 * Validates the server-supplied socket URL against the configured API origin
 * before connecting. A redirected socket would carry a live microphone to
 * wherever the redirect pointed.
 */
internal fun validatedVoiceSocketUrl(serverUrl: String, apiBaseUrl: String): String {
    val normalized = serverUrl
        .replaceFirst("wss://", "https://")
        .replaceFirst("ws://", "http://")
    val parsed = normalized.toHttpUrlOrNull() ?: throw IllegalArgumentException("Invalid voice URL")
    val expected = apiBaseUrl.toHttpUrlOrNull() ?: throw IllegalArgumentException("Invalid API URL")
    val permitsLocalCleartext = BuildConfig.DEBUG &&
        parsed.scheme == "http" &&
        (parsed.host == "10.0.2.2" || parsed.host == "localhost")
    require(parsed.scheme == "https" || permitsLocalCleartext) { "Voice requires a secure transport" }
    require(parsed.scheme == expected.scheme && parsed.host == expected.host && parsed.port == expected.port) {
        "Voice endpoint must match the configured API origin"
    }
    require(parsed.encodedUsername.isEmpty() && parsed.encodedPassword.isEmpty()) {
        "Voice URL must not contain user information"
    }
    require(parsed.encodedPath == "/v1/ai/voice") { "Unexpected voice path" }
    require(parsed.query == null && parsed.fragment == null) { "Voice URL must not contain credentials" }
    return if (parsed.scheme == "https") {
        parsed.toString().replaceFirst("https://", "wss://")
    } else {
        parsed.toString().replaceFirst("http://", "ws://")
    }
}

/** What the server may ask of the interface mid-session. */
data class VoiceToolConfirmation(
    val callId: String,
    val name: String,
    val title: String,
)

sealed interface VoiceEvent {
    data object Ready : VoiceEvent
    data class Transcript(val text: String, val final: Boolean) : VoiceEvent
    data class ConfirmationRequested(val confirmation: VoiceToolConfirmation) : VoiceEvent
    data class ToolSettled(val callId: String, val decision: String) : VoiceEvent
    data class Failed(val reason: String) : VoiceEvent
    data class Closed(val reason: String) : VoiceEvent
}

/**
 * Decodes one server frame. Separated from the socket so the protocol can be
 * tested without one.
 */
internal fun decodeVoiceFrame(json: Json, raw: String): VoiceEvent? {
    val root = runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return null
    val type = (root["type"] as? JsonPrimitive)?.contentOrNull ?: return null
    return when (type) {
        "ready" -> VoiceEvent.Ready
        "transcript" -> {
            val text = (root["text"] as? JsonPrimitive)?.contentOrNull ?: return null
            VoiceEvent.Transcript(text, (root["final"] as? JsonPrimitive)?.booleanOrNull ?: false)
        }

        "tool_confirmation" -> {
            val callId = (root["callId"] as? JsonPrimitive)?.contentOrNull ?: return null
            val name = (root["name"] as? JsonPrimitive)?.contentOrNull ?: return null
            val title = (root["title"] as? JsonPrimitive)?.contentOrNull ?: name
            VoiceEvent.ConfirmationRequested(VoiceToolConfirmation(callId, name, title))
        }

        "tool_result" -> {
            val callId = (root["callId"] as? JsonPrimitive)?.contentOrNull ?: return null
            val decision = (root["decision"] as? JsonPrimitive)?.contentOrNull ?: return null
            VoiceEvent.ToolSettled(callId, decision)
        }

        "error" -> VoiceEvent.Failed((root["reason"] as? JsonPrimitive)?.contentOrNull ?: "unknown")
        "closed" -> VoiceEvent.Closed((root["reason"] as? JsonPrimitive)?.contentOrNull ?: "closed")
        else -> null
    }
}

/**
 * Captures the microphone, plays what comes back, and carries nothing else.
 *
 * Recorder and player are released on every stop rather than left allocated, so
 * "the session ended" and "the microphone is off" cannot come apart.
 */
class VoiceClient(
    private val api: ApiClient,
    private val json: Json,
    private val scope: CoroutineScope,
) {
    private val mutableEvents = MutableSharedFlow<VoiceEvent>(
        extraBufferCapacity = 32,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val events: Flow<VoiceEvent> = mutableEvents

    private val mutableListening = MutableStateFlow(false)

    /** Reflects the recorder's actual state, not the app's belief about it. */
    val listening: StateFlow<Boolean> = mutableListening.asStateFlow()

    private var socket: WebSocket? = null
    private var captureJob: Job? = null
    private var record: AudioRecord? = null
    private var track: AudioTrack? = null

    /**
     * Opens the socket. The caller must already hold RECORD_AUDIO: a session
     * that starts without it would be a microphone indicator with no microphone.
     */
    fun start(ticket: AiVoiceTicketDto) {
        if (socket != null) return
        val url = validatedVoiceSocketUrl(ticket.webSocketUrl, BuildConfig.API_BASE_URL)
        val request = Request.Builder()
            .url(url)
            .header("Sec-WebSocket-Protocol", voiceProtocolHeader(ticket.ticket))
            .build()

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                startAudio(ticket.audio.sampleRateHz, ticket.audio.outputSampleRateHz)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                decodeVoiceFrame(json, text)?.let { event ->
                    mutableEvents.tryEmit(event)
                    if (event is VoiceEvent.Closed) stop()
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                play(bytes.toByteArray())
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                mutableEvents.tryEmit(VoiceEvent.Closed(reason.ifEmpty { "closed" }))
                stop()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                // A dropped socket ends the session rather than retrying:
                // silently reconnecting a live microphone is not something to do
                // on the user's behalf.
                mutableEvents.tryEmit(VoiceEvent.Closed("transport"))
                stop()
            }
        }
        socket = api.okHttpClient.newWebSocket(request, listener)
    }

    fun confirm(callId: String) = sendJson("confirm", callId)

    fun decline(callId: String) = sendJson("decline", callId)

    fun stop() {
        val open = socket
        socket = null
        if (open != null) {
            open.send("""{"type":"end"}""")
            open.close(1000, "user ended")
        }
        captureJob?.cancel()
        captureJob = null
        stopAudio()
    }

    private fun sendJson(type: String, callId: String) {
        socket?.send("""{"type":"$type","callId":"$callId"}""")
    }

    private fun startAudio(sampleRateHz: Int, outputSampleRateHz: Int) {
        if (record != null) return
        val minimum = AudioRecord.getMinBufferSize(
            sampleRateHz,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minimum <= 0) {
            mutableEvents.tryEmit(VoiceEvent.Failed("microphone_unavailable"))
            return
        }
        // A frame of roughly a tenth of a second: small enough to feel like a
        // conversation, large enough not to send a packet per audio callback.
        val frameBytes = (sampleRateHz / 10) * 2
        val recorder = try {
            AudioRecord(
                // VOICE_COMMUNICATION applies the platform's echo cancellation,
                // without which the assistant hears its own playback.
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                sampleRateHz,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                maxOf(minimum, frameBytes * 2),
            )
        } catch (_: SecurityException) {
            mutableEvents.tryEmit(VoiceEvent.Failed("microphone_denied"))
            return
        }
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            mutableEvents.tryEmit(VoiceEvent.Failed("microphone_unavailable"))
            return
        }

        val player = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(outputSampleRateHz)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(
                maxOf(
                    AudioTrack.getMinBufferSize(
                        outputSampleRateHz,
                        AudioFormat.CHANNEL_OUT_MONO,
                        AudioFormat.ENCODING_PCM_16BIT,
                    ),
                    frameBytes * 4,
                ),
            )
            .build()

        record = recorder
        track = player
        recorder.startRecording()
        player.play()
        mutableListening.value = true

        captureJob = scope.launch(Dispatchers.IO) {
            val buffer = ByteArray(frameBytes)
            while (isActive && record != null) {
                val read = recorder.read(buffer, 0, buffer.size)
                if (read <= 0) continue
                // The buffer is copied into the frame that is sent and then
                // reused. Nothing accumulates, and nothing is written to disk.
                socket?.send(buffer.toByteString(0, read))
            }
        }
    }

    private fun play(pcm: ByteArray) {
        if (pcm.isEmpty()) return
        track?.write(pcm, 0, pcm.size)
    }

    private fun stopAudio() {
        mutableListening.value = false
        record?.let { recorder ->
            runCatching { recorder.stop() }
            recorder.release()
        }
        record = null
        track?.let { player ->
            runCatching { player.stop() }
            player.release()
        }
        track = null
    }
}

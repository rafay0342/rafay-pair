package com.rafaypair.android.data.network

import com.rafaypair.android.BuildConfig
import com.rafaypair.android.data.local.AccountPairScope
import com.rafaypair.android.data.local.AppPreferences
import com.rafaypair.android.domain.model.PairStatus
import com.rafaypair.android.domain.model.RealtimeState
import com.rafaypair.android.domain.model.SessionState
import com.rafaypair.android.domain.repository.AuthRepository
import com.rafaypair.android.domain.repository.PairRepository
import com.rafaypair.android.domain.repository.RealtimeRepository
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.min
import kotlin.random.Random
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

internal const val REALTIME_APPLICATION_PROTOCOL = "rafaypair.v1"
internal const val REALTIME_TICKET_PROTOCOL_PREFIX = "rafaypair.ticket."

internal fun realtimeProtocolHeader(ticket: String): String {
    require(Regex("^[A-Za-z0-9_-]{43}$").matches(ticket)) { "Invalid realtime ticket" }
    return "$REALTIME_APPLICATION_PROTOCOL, $REALTIME_TICKET_PROTOCOL_PREFIX$ticket"
}

internal fun validatedRealtimeSocketUrl(serverUrl: String, apiBaseUrl: String): String {
    val normalized = serverUrl
        .replaceFirst("wss://", "https://")
        .replaceFirst("ws://", "http://")
    val parsed = normalized.toHttpUrlOrNull() ?: throw IllegalArgumentException("Invalid realtime URL")
    val expected = apiBaseUrl.toHttpUrlOrNull() ?: throw IllegalArgumentException("Invalid API URL")
    val permitsLocalCleartext = BuildConfig.DEBUG &&
        parsed.scheme == "http" &&
        (parsed.host == "10.0.2.2" || parsed.host == "localhost")
    require(parsed.scheme == "https" || permitsLocalCleartext) { "Realtime requires a secure transport" }
    require(parsed.scheme == expected.scheme && parsed.host == expected.host && parsed.port == expected.port) {
        "Realtime endpoint must match the configured API origin"
    }
    require(parsed.encodedUsername.isEmpty() && parsed.encodedPassword.isEmpty()) {
        "Realtime URL must not contain user information"
    }
    require(parsed.encodedPath == "/v1/realtime") { "Unexpected realtime path" }
    require(parsed.query == null && parsed.fragment == null) { "Realtime URL must not contain credentials" }
    return if (parsed.scheme == "https") {
        parsed.toString().replaceFirst("https://", "wss://")
    } else {
        parsed.toString().replaceFirst("http://", "ws://")
    }
}

class DefaultRealtimeRepository(
    private val api: ApiClient,
    private val json: Json,
    private val preferences: AppPreferences,
    private val scope: CoroutineScope,
    private val authRepository: AuthRepository,
    private val pairRepository: PairRepository,
) : RealtimeRepository {
    private val mutableState = MutableStateFlow(RealtimeState.STOPPED)
    override val state: StateFlow<RealtimeState> = mutableState
    private val mutableEvents = MutableSharedFlow<String>(extraBufferCapacity = 32)
    override val events: Flow<String> = mutableEvents
    private val shouldRun = AtomicBoolean(false)
    private var recoveryJob: Job? = null
    private var socket: WebSocket? = null

    override fun start() {
        if (!shouldRun.compareAndSet(false, true)) return
        recoveryJob = scope.launch { recoveryLoop() }
    }

    override fun stop() {
        shouldRun.set(false)
        recoveryJob?.cancel()
        recoveryJob = null
        socket?.close(1000, "Client stopped")
        socket = null
        mutableState.value = RealtimeState.STOPPED
    }

    private suspend fun recoveryLoop() {
        var attempt = 0
        while (shouldRun.get()) {
            mutableState.value = if (attempt == 0) RealtimeState.CONNECTING else RealtimeState.RECOVERING
            val completed = CompletableDeferred<Unit>()
            try {
                val expectedScope = currentScope() ?: break
                val cursor = preferences.realtimeCursor(expectedScope)
                val ticket = api.realtimeTicket(cursor)
                val socketUrl = validatedRealtimeSocketUrl(ticket.webSocketUrl, BuildConfig.API_BASE_URL)
                val protocolHeader = realtimeProtocolHeader(ticket.ticket)
                val listener = object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        attempt = 0
                        mutableState.value = RealtimeState.CONNECTED
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        scope.launch { handleMessage(text, expectedScope) }
                    }

                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                        completed.complete(Unit)
                    }

                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                        completed.complete(Unit)
                    }
                }
                val request = Request.Builder()
                    .url(socketUrl)
                    .header("Sec-WebSocket-Protocol", protocolHeader)
                    .build()
                socket = api.okHttpClient.newWebSocket(request, listener)
                completed.await()
            } catch (_: Exception) {
                // Recovery below obtains a fresh short-lived ticket and replays from the stored event cursor.
            } finally {
                socket = null
            }
            if (!shouldRun.get()) break
            attempt += 1
            mutableState.value = RealtimeState.RECOVERING
            val cappedSeconds = min(30, 1 shl min(attempt, 5))
            delay(cappedSeconds * 1_000L + Random.nextLong(0, 750))
        }
    }

    private suspend fun handleMessage(text: String, expectedScope: AccountPairScope) {
        val event = runCatching {
            json.decodeFromString(RealtimeEnvelopeDto.serializer(), text)
        }.getOrNull() ?: return
        if (
            event.version != 1 ||
            event.eventId.toLongOrNull()?.let { it >= 0 } != true ||
            event.pairId != expectedScope.pairId ||
            currentScope() != expectedScope
        ) {
            return
        }
        if (!preferences.setRealtimeCursor(expectedScope, event.eventId)) return
        mutableEvents.emit(event.type)
    }

    private fun currentScope(): AccountPairScope? {
        val ownerId = (authRepository.session.value as? SessionState.SignedIn)?.user?.id ?: return null
        val pairId = pairRepository.pair.value?.takeIf { it.status == PairStatus.ACTIVE }?.id ?: return null
        return AccountPairScope(ownerId, pairId)
    }
}

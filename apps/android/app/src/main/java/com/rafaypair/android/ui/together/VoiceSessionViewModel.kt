package com.rafaypair.android.ui.together

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.rafaypair.android.data.network.VoiceClient
import com.rafaypair.android.data.network.VoiceEvent
import com.rafaypair.android.data.network.VoiceToolConfirmation
import com.rafaypair.android.domain.model.AiSession
import com.rafaypair.android.domain.model.RepositoryFailure
import com.rafaypair.android.domain.repository.AssistantRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class VoicePhase { IDLE, STARTING, LISTENING, ENDING, UNAVAILABLE }

data class VoiceUiState(
    val phase: VoicePhase = VoicePhase.IDLE,
    val session: AiSession? = null,
    val microphoneOn: Boolean = false,
    val transcript: List<String> = emptyList(),
    val pendingConfirmation: VoiceToolConfirmation? = null,
    val message: String? = null,
) {
    val disclosure: String
        get() = session?.identityDisclosure
            ?: "Rafay AI is a generated voice, not a person, and not a clinician."
}

/**
 * Drives one voice conversation with Rafay AI.
 *
 * The order below is the product commitment expressed as control flow: a session
 * exists, its disclosure is shown, the disclosure is recorded as shown, and only
 * then is a socket opened. The server refuses a socket for a session that never
 * announced itself, so the order cannot be skipped by a client that forgets it —
 * but it is written here plainly anyway.
 */
class VoiceSessionViewModel(
    private val assistant: AssistantRepository,
    private val client: VoiceClient,
) : ViewModel() {
    private val _state = MutableStateFlow(VoiceUiState())
    val state: StateFlow<VoiceUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            client.events.collect { event -> apply(event) }
        }
        viewModelScope.launch {
            client.listening.collect { listening ->
                _state.update { it.copy(microphoneOn = listening) }
            }
        }
    }

    /** Called once the caller holds RECORD_AUDIO. A refusal is a refusal. */
    fun start(microphoneGranted: Boolean) {
        if (_state.value.phase != VoicePhase.IDLE && _state.value.phase != VoicePhase.UNAVAILABLE) {
            return
        }
        if (!microphoneGranted) {
            _state.update {
                it.copy(
                    phase = VoicePhase.UNAVAILABLE,
                    message = "Rafay AI needs the microphone to hear you.",
                )
            }
            return
        }
        _state.update {
            it.copy(phase = VoicePhase.STARTING, message = null, transcript = emptyList())
        }
        viewModelScope.launch {
            try {
                // An existing session is reused rather than stacked: the server
                // allows one at a time, and a second would only fail.
                val opened = assistant.currentSession() ?: assistant.startSession()
                if (opened == null) {
                    fail("A voice session could not be started.")
                    return@launch
                }
                _state.update { it.copy(session = opened) }

                // Recorded before any audio can play, which is what makes the
                // requirement auditable rather than aspirational.
                val announced = assistant.announceIdentity(opened.id) ?: opened
                _state.update { it.copy(session = announced) }

                client.start(assistant.voiceTicket(opened.id))
                _state.update { it.copy(phase = VoicePhase.LISTENING) }
            } catch (failure: RepositoryFailure) {
                fail(
                    when (failure.status) {
                        503 -> "Voice is not available on this deployment yet."
                        403 -> "Resume sharing before starting a voice session."
                        else -> failure.message
                    },
                )
            } catch (_: IllegalArgumentException) {
                fail("The voice endpoint did not look like RafayPair.")
            }
        }
    }

    fun stop() {
        val current = _state.value
        if (current.phase == VoicePhase.IDLE) return
        _state.update { it.copy(phase = VoicePhase.ENDING) }
        client.stop()
        viewModelScope.launch {
            current.session?.let { runCatching { assistant.endSession(it.id) } }
            _state.update {
                VoiceUiState(transcript = it.transcript)
            }
        }
    }

    fun confirm() {
        val pending = _state.value.pendingConfirmation ?: return
        _state.update { it.copy(pendingConfirmation = null) }
        client.confirm(pending.callId)
    }

    fun decline() {
        val pending = _state.value.pendingConfirmation ?: return
        _state.update { it.copy(pendingConfirmation = null) }
        client.decline(pending.callId)
    }

    override fun onCleared() {
        client.stop()
        super.onCleared()
    }

    private fun apply(event: VoiceEvent) {
        when (event) {
            VoiceEvent.Ready -> _state.update { it.copy(phase = VoicePhase.LISTENING) }

            is VoiceEvent.Transcript ->
                // Only completed lines are kept. A partial line rewritten in
                // place reads as the assistant changing its mind about what you
                // said.
                if (event.final) {
                    _state.update { it.copy(transcript = it.transcript + event.text) }
                }

            is VoiceEvent.ConfirmationRequested ->
                _state.update { it.copy(pendingConfirmation = event.confirmation) }

            is VoiceEvent.ToolSettled -> Unit

            is VoiceEvent.Failed -> fail(friendly(event.reason))

            is VoiceEvent.Closed -> {
                val session = _state.value.session
                _state.update { VoiceUiState(transcript = it.transcript) }
                viewModelScope.launch {
                    session?.let { runCatching { assistant.endSession(it.id) } }
                }
            }
        }
    }

    private fun fail(message: String) {
        client.stop()
        _state.update {
            it.copy(phase = VoicePhase.UNAVAILABLE, message = message, pendingConfirmation = null)
        }
    }

    private fun friendly(reason: String): String = when (reason) {
        "frame_too_large" -> "That audio frame was too large to send."
        "microphone_denied" -> "Rafay AI needs the microphone to hear you."
        "microphone_unavailable" -> "The microphone could not be opened."
        "provider_error", "transport_error", "transport" ->
            "The connection to the voice service dropped."

        else -> "The voice session stopped."
    }

    class Factory(
        private val assistant: AssistantRepository,
        private val client: VoiceClient,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T =
            VoiceSessionViewModel(assistant, client) as T
    }
}

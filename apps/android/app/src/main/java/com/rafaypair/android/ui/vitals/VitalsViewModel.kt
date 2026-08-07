package com.rafaypair.android.ui.vitals

import androidx.lifecycle.ViewModel
import com.rafaypair.android.physiology.BreathingEstimator
import com.rafaypair.android.physiology.BreathingPattern
import com.rafaypair.android.physiology.BreathingPhase
import com.rafaypair.android.physiology.BreathingPhaseState
import com.rafaypair.android.physiology.PhysiologyTuning
import com.rafaypair.android.physiology.PulseEstimator
import com.rafaypair.android.physiology.PulseFreshness
import com.rafaypair.android.physiology.PulseRejectionReason
import com.rafaypair.android.physiology.PulseResult
import com.rafaypair.android.physiology.PulseSample
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** The measurement window the interface counts down, comfortably above the
 * engine's eight-second minimum. */
const val PULSE_TARGET_DURATION_MS = 20_000.0

data class VitalsUiState(
    val measuring: Boolean = false,
    val fingerDetected: Boolean = false,
    val progress: Double = 0.0,
    val latestPulse: PulseResult.Measured? = null,
    val lastRejection: PulseRejectionReason? = null,
    val cameraError: String? = null,
    val breathingPattern: BreathingPattern = BreathingPattern.calm(6),
    val breathingStartedAtMs: Long? = null,
    val nowMs: Long = 0L,
) {
    val pulseIsFresh: Boolean
        get() = latestPulse?.let { PulseFreshness.isFresh(it, nowMs.toDouble()) } ?: false

    val pulseAgeSeconds: Int
        get() = latestPulse?.let {
            (PulseFreshness.ageMs(it, nowMs.toDouble()) / 1000).toInt()
        } ?: 0

    /** The rate the heart animates at, or `null` when nothing is current. A
     * stale reading is never animated as if live. */
    val animatedBpm: Double?
        get() = if (pulseIsFresh) latestPulse?.bpm else null

    val breathingPhase: BreathingPhaseState?
        get() = breathingStartedAtMs?.let {
            BreathingEstimator.phaseAt(breathingPattern, (nowMs - it).toDouble())
        }?.takeIf { it.phase != BreathingPhase.COMPLETE }
}

/**
 * Drives the pulse measurement session, the heart visualization's freshness, and
 * guided breathing. Everything is on-device; a result reaches a partner only
 * through an explicit, consent-gated share.
 */
class VitalsViewModel : ViewModel() {
    private val samples = mutableListOf<PulseSample>()

    private val _state = MutableStateFlow(VitalsUiState())
    val state: StateFlow<VitalsUiState> = _state.asStateFlow()

    fun tick(nowMs: Long) {
        _state.update { it.copy(nowMs = nowMs) }
    }

    fun beginMeasurement() {
        samples.clear()
        _state.update {
            it.copy(
                measuring = true,
                fingerDetected = false,
                progress = 0.0,
                lastRejection = null,
                cameraError = null,
            )
        }
    }

    fun onSample(sample: PulseSample) {
        if (!_state.value.measuring) return
        samples.add(sample)
        val first = samples.first().timestampMs
        val elapsed = sample.timestampMs - first
        val detected = sample.red >= PhysiologyTuning.FINGER_MIN_RED &&
            sample.green <= PhysiologyTuning.FINGER_MAX_GREEN &&
            sample.red - sample.green >= PhysiologyTuning.FINGER_MIN_RED_EXCESS
        _state.update {
            it.copy(
                fingerDetected = detected,
                progress = minOf(1.0, elapsed / PULSE_TARGET_DURATION_MS),
            )
        }
    }

    /**
     * Scores the collected session. A rejection replaces nothing: the previous
     * reading keeps its own timestamp and freshness rather than being refreshed
     * by a failed attempt.
     */
    fun finishMeasurement(nowMs: Long) {
        if (!_state.value.measuring) return
        val result = PulseEstimator.estimate(samples.toList(), nowMs.toDouble())
        _state.update { current ->
            when (result) {
                is PulseResult.Measured ->
                    current.copy(measuring = false, latestPulse = result, lastRejection = null)

                is PulseResult.Rejected ->
                    current.copy(measuring = false, lastRejection = result.reason)
            }
        }
    }

    fun cameraFailed(message: String) {
        _state.update { it.copy(measuring = false, cameraError = message) }
    }

    fun startBreathing(pattern: BreathingPattern, nowMs: Long) {
        _state.update { it.copy(breathingPattern = pattern, breathingStartedAtMs = nowMs) }
    }

    fun stopBreathing() {
        _state.update { it.copy(breathingStartedAtMs = null) }
    }

    fun guidance(reason: PulseRejectionReason): String = when (reason) {
        PulseRejectionReason.TOO_SHORT ->
            "Hold still a little longer — measuring needs about twenty seconds."

        PulseRejectionReason.FINGER_NOT_DETECTED ->
            "Cover the rear camera and the torch completely with your fingertip."

        PulseRejectionReason.EXCESSIVE_MOTION ->
            "Rest your hand on something steady and try again."

        PulseRejectionReason.NO_PERIODICITY ->
            "No steady pulse came through. Press gently, without squeezing."

        PulseRejectionReason.UNSTABLE ->
            "The reading kept drifting. Try again while staying still."

        PulseRejectionReason.OUT_OF_RANGE ->
            "The result was outside a plausible range, so it was discarded."
    }
}

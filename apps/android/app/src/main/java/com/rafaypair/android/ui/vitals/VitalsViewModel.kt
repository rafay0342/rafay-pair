package com.rafaypair.android.ui.vitals

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import com.rafaypair.android.physiology.AudioBreathingEstimator
import com.rafaypair.android.physiology.AudioBreathingRejectionReason
import com.rafaypair.android.physiology.AudioBreathingResult
import com.rafaypair.android.physiology.AudioHopFeature
import com.rafaypair.android.physiology.BreathingEstimator
import com.rafaypair.android.physiology.BreathingPattern
import com.rafaypair.android.physiology.BreathingPhase
import com.rafaypair.android.physiology.BreathingPhaseState
import com.rafaypair.android.physiology.BreathingRejectionReason
import com.rafaypair.android.physiology.BreathingResult
import com.rafaypair.android.physiology.BreathingSample
import com.rafaypair.android.physiology.ChestSample
import com.rafaypair.android.pose.JointName
import com.rafaypair.android.pose.PoseFrame
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
    /**
     * Off by default: listening is opt-in even inside a session the user already
     * started, because a microphone is a distinct expectation from a paced
     * animation.
     */
    val listenForBreathing: Boolean = false,
    val listening: Boolean = false,
    val breathAudible: Boolean = false,
    val breathingEstimate: AudioBreathingResult.Measured? = null,
    val breathingRejection: AudioBreathingRejectionReason? = null,
    val microphoneError: String? = null,
    /**
     * Off by default and hidden entirely unless the experiment flag is on.
     * Master specification §24: no experimental physiological feature may be
     * enabled silently.
     */
    val cameraBreathingOffered: Boolean = false,
    val watchForBreathing: Boolean = false,
    val watching: Boolean = false,
    val chestVisible: Boolean = false,
    val cameraBreathingEstimate: BreathingResult.Measured? = null,
    val cameraBreathingRejection: BreathingRejectionReason? = null,
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
class VitalsViewModel(cameraBreathingOffered: Boolean = false) : ViewModel() {
    private val samples = mutableListOf<PulseSample>()
    private val hops = mutableListOf<AudioHopFeature>()
    private val chestSamples = mutableListOf<BreathingSample>()

    private val _state = MutableStateFlow(
        VitalsUiState(cameraBreathingOffered = cameraBreathingOffered),
    )
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
        hops.clear()
        chestSamples.clear()
        _state.update {
            it.copy(
                breathingPattern = pattern,
                breathingStartedAtMs = nowMs,
                listening = it.listenForBreathing,
                watching = it.watchForBreathing && it.cameraBreathingOffered,
                chestVisible = false,
                cameraBreathingEstimate = null,
                cameraBreathingRejection = null,
                breathAudible = false,
                breathingEstimate = null,
                breathingRejection = null,
                microphoneError = null,
            )
        }
    }

    fun setListenForBreathing(enabled: Boolean) {
        _state.update { it.copy(listenForBreathing = enabled) }
    }

    fun setWatchForBreathing(enabled: Boolean) {
        // Ignored outright when the experiment is not offered, so a stale UI
        // event cannot turn on a camera the user was never shown a control for.
        if (!_state.value.cameraBreathingOffered) return
        _state.update { it.copy(watchForBreathing = enabled) }
    }

    /**
     * Turns one pose frame into one breathing sample and releases the frame.
     *
     * The landmarks are reduced here, in the callback, exactly as the workout
     * path does: nothing retains a frame, and the estimator's input type carries
     * only a scalar per sample.
     */
    fun onBreathingFrame(frame: PoseFrame) {
        if (!_state.value.watching) return
        val sample = ChestSample.from(
            timestampMs = frame.timestampMs,
            leftShoulder = frame.joint(JointName.LEFT_SHOULDER).toChestPoint(),
            rightShoulder = frame.joint(JointName.RIGHT_SHOULDER).toChestPoint(),
            leftHip = frame.joint(JointName.LEFT_HIP).toChestPoint(),
            rightHip = frame.joint(JointName.RIGHT_HIP).toChestPoint(),
        )
        chestSamples.add(sample)
        _state.update { it.copy(chestVisible = sample.tracked) }
    }

    fun onBreathHops(produced: List<AudioHopFeature>) {
        if (!_state.value.listening) return
        hops.addAll(produced)
        val audible = produced.lastOrNull()?.let(AudioBreathingEstimator::isHopUsable) ?: false
        _state.update { it.copy(breathAudible = audible) }
    }

    fun microphoneFailed(message: String) {
        _state.update { it.copy(listening = false, microphoneError = message) }
    }

    /** Ends the session and scores it. A rejection replaces nothing. */
    fun stopBreathing(nowMs: Long) {
        val collected = hops.toList()
        hops.clear()
        val watched = chestSamples.toList()
        chestSamples.clear()
        val cameraResult = if (watched.isEmpty()) {
            null
        } else {
            BreathingEstimator.estimate(watched, nowMs.toDouble())
        }
        val result = if (collected.isEmpty()) {
            null
        } else {
            AudioBreathingEstimator.estimate(collected, nowMs.toDouble())
        }
        _state.update { current ->
            current.copy(
                breathingStartedAtMs = null,
                listening = false,
                breathingEstimate = result as? AudioBreathingResult.Measured
                    ?: current.breathingEstimate,
                breathingRejection = (result as? AudioBreathingResult.Rejected)?.reason,
                watching = false,
                chestVisible = false,
                cameraBreathingEstimate = cameraResult as? BreathingResult.Measured
                    ?: current.cameraBreathingEstimate,
                cameraBreathingRejection = (cameraResult as? BreathingResult.Rejected)?.reason,
            )
        }
    }

    fun audioGuidance(reason: AudioBreathingRejectionReason): String = when (reason) {
        AudioBreathingRejectionReason.TOO_SHORT ->
            "Listening needs about twenty seconds of breathing to say anything."

        AudioBreathingRejectionReason.NOT_AUDIBLE ->
            "Too quiet to hear. Try holding the phone a little closer."

        AudioBreathingRejectionReason.TOO_NOISY ->
            "There was too much background sound to pick out breathing."

        AudioBreathingRejectionReason.NO_PERIODICITY -> "No steady rhythm came through."

        AudioBreathingRejectionReason.UNSTABLE ->
            "The rhythm kept changing, so no single rate would be honest."

        AudioBreathingRejectionReason.OUT_OF_RANGE ->
            "The result was outside a plausible range, so it was discarded."
    }

    fun cameraBreathingGuidance(reason: BreathingRejectionReason): String = when (reason) {
        BreathingRejectionReason.TOO_SHORT ->
            "Watching needs about half a minute of steady breathing to say anything."

        BreathingRejectionReason.NOT_TRACKED ->
            "Your torso was not in view for enough of the session."

        BreathingRejectionReason.EXCESSIVE_MOTION ->
            "There was too much movement to read breathing from chest motion."

        BreathingRejectionReason.NO_PERIODICITY -> "No steady rhythm came through."

        BreathingRejectionReason.UNSTABLE ->
            "The rhythm kept changing, so no single rate would be honest."

        BreathingRejectionReason.OUT_OF_RANGE ->
            "The result was outside a plausible range, so it was discarded."
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
    class Factory(private val cameraBreathingOffered: Boolean) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T =
            VitalsViewModel(cameraBreathingOffered) as T
    }

}

private fun com.rafaypair.android.pose.Joint.toChestPoint() =
    ChestSample.Point(x = x, y = y, visibility = visibility)
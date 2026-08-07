package com.rafaypair.android.ui.workout

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.rafaypair.android.domain.model.TogetherStatus
import com.rafaypair.android.domain.repository.TogetherRepository
import com.rafaypair.android.pose.ExerciseEngine
import com.rafaypair.android.pose.FormEvent
import com.rafaypair.android.pose.PoseEngine
import com.rafaypair.android.pose.PoseFrame
import com.rafaypair.android.pose.ReportedPosture
import com.rafaypair.android.pose.Repetition
import com.rafaypair.android.physiology.CalorieActivity
import com.rafaypair.android.physiology.CalorieEstimate
import com.rafaypair.android.physiology.CalorieEstimateInput
import com.rafaypair.android.physiology.CalorieEstimator
import com.rafaypair.android.pose.SessionSummary
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class WorkoutUiState(
    val isRecording: Boolean = false,
    val tracking: Boolean = false,
    val framingOk: Boolean = true,
    val reportedPosture: ReportedPosture = ReportedPosture.UNKNOWN,
    val repetitionCount: Int = 0,
    val lastRepetition: Repetition? = null,
    val summary: SessionSummary? = null,
    val calories: CalorieEstimate? = null,
    /** Set only while an accepted together session is open on this account. */
    val sharingWithPartner: Boolean = false,
    val startedAtMs: Long = 0L,
) {
    val guidance: String
        get() = when {
            !isRecording -> "Start a session when you are ready."
            !tracking -> "Step into view so your whole body is visible."
            !framingOk -> "Move back a little — your feet are outside the frame."
            reportedPosture == ReportedPosture.UNKNOWN ->
                "Hold still for a moment while tracking settles."
            reportedPosture == ReportedPosture.STANDING ->
                "Standing. Lower into a squat when you are ready."
            reportedPosture == ReportedPosture.SQUATTING -> "Squatting — keep your chest lifted."
            reportedPosture == ReportedPosture.SITTING -> "Sitting."
            else -> "Lying down."
        }

    val formHints: List<String>
        get() = lastRepetition?.formEvents.orEmpty().map { event ->
            when (event) {
                FormEvent.SHALLOW_DEPTH -> "Try to sit a little lower on the next one."
                FormEvent.FORWARD_LEAN -> "Keep your chest a bit more upright."
                FormEvent.UNEVEN -> "Weight looked uneven between your legs."
            }
        }
}

/**
 * Drives the pose and exercise engines from captured frames.
 *
 * Everything here is on-device. No landmark, frame, or summary is transmitted;
 * sharing a summary with a partner is a separate, consent-gated action.
 */
class WorkoutViewModel(
    /**
     * Absent in previews and tests. When present, and only while an accepted
     * together session is open, the counts this engine derives are published to
     * the partner. The engine's inputs never leave the device.
     */
    private val together: TogetherRepository? = null,
    private val clock: () -> Long = System::currentTimeMillis,
) : ViewModel() {
    private val poseEngine = PoseEngine()
    private val exerciseEngine = ExerciseEngine()
    private var publishJob: Job? = null

    private val _state = MutableStateFlow(WorkoutUiState())
    val state: StateFlow<WorkoutUiState> = _state.asStateFlow()

    fun startSession() {
        poseEngine.reset()
        exerciseEngine.reset()
        _state.value = WorkoutUiState(isRecording = true, startedAtMs = clock())
        startPublishing()
    }

    fun endSession() {
        if (!_state.value.isRecording) return
        publishJob?.cancel()
        publishJob = null
        val summary = exerciseEngine.summary()
        // Body mass is only supplied when the user has chosen to give it, and
        // its absence widens the band rather than being guessed at.
        val calories = CalorieEstimator.estimate(
            CalorieEstimateInput(
                activity = CalorieActivity.SQUAT,
                durationMs = summary.endedAtMs - summary.startedAtMs,
                repetitions = summary.repetitionCount,
            ),
        )
        _state.update {
            it.copy(isRecording = false, summary = summary, calories = calories)
        }
        // A final publish so the partner's screen settles on the real total
        // rather than on whichever tick happened to land last.
        viewModelScope.launch { publishOnce(finished = true) }
    }

    fun onFrame(frame: PoseFrame) {
        if (!_state.value.isRecording) return
        val observation = poseEngine.process(frame)
        val result = exerciseEngine.process(observation)
        _state.update { current ->
            current.copy(
                tracking = observation.valid,
                framingOk = observation.framingOk,
                reportedPosture = result.reportedPosture,
                repetitionCount = result.repetitionCount,
                lastRepetition = result.completedRepetition ?: current.lastRepetition,
            )
        }
    }

    /**
     * Publishes derived state on a fixed cadence rather than on every frame.
     * Per-frame publishing would put the pose sampling rate itself on the wire,
     * which is a detail of what the camera saw.
     */
    private fun startPublishing() {
        val repository = together ?: return
        publishJob?.cancel()
        publishJob = viewModelScope.launch {
            val session = runCatching { repository.current() }.getOrNull()
            if (session == null || session.status != TogetherStatus.ACTIVE) return@launch
            _state.update { it.copy(sharingWithPartner = true) }
            openSessionId = session.id
            while (isActive && _state.value.isRecording) {
                publishOnce(finished = false)
                delay(PUBLISH_INTERVAL_MS)
            }
        }
    }

    private var openSessionId: String? = null

    private suspend fun publishOnce(finished: Boolean) {
        val repository = together ?: return
        val sessionId = openSessionId ?: return
        val current = _state.value
        val elapsed = (clock() - current.startedAtMs).coerceAtLeast(0L)
        val updated = runCatching {
            repository.publishState(
                id = sessionId,
                repetitions = current.repetitionCount,
                exercisePhase = if (finished) "complete" else phaseOf(current.reportedPosture),
                setIndex = 0,
                elapsedMs = elapsed.toInt(),
                estimatedKcal = current.calories?.estimatedKcal,
            )
        }.getOrNull()
        if (finished || updated == null) {
            openSessionId = updated?.takeIf { it.status == TogetherStatus.ACTIVE }?.id
            if (openSessionId == null) _state.update { it.copy(sharingWithPartner = false) }
        }
    }

    /**
     * Only what the posture classifier actually reports. There is no
     * "ascending": the engine does not distinguish it, so claiming it would be
     * inventing a phase.
     */
    private fun phaseOf(posture: ReportedPosture): String = when (posture) {
        ReportedPosture.UNKNOWN -> "idle"
        ReportedPosture.SQUATTING -> "bottom"
        ReportedPosture.STANDING, ReportedPosture.SITTING, ReportedPosture.LYING_DOWN -> "resting"
    }

    class Factory(private val together: TogetherRepository?) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T =
            WorkoutViewModel(together) as T
    }
}

private const val PUBLISH_INTERVAL_MS = 2_000L

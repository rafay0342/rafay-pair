package com.rafaypair.android.ui.workout

import androidx.lifecycle.ViewModel
import com.rafaypair.android.pose.ExerciseEngine
import com.rafaypair.android.pose.FormEvent
import com.rafaypair.android.pose.PoseEngine
import com.rafaypair.android.pose.PoseFrame
import com.rafaypair.android.pose.ReportedPosture
import com.rafaypair.android.pose.Repetition
import com.rafaypair.android.pose.SessionSummary
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

data class WorkoutUiState(
    val isRecording: Boolean = false,
    val tracking: Boolean = false,
    val framingOk: Boolean = true,
    val reportedPosture: ReportedPosture = ReportedPosture.UNKNOWN,
    val repetitionCount: Int = 0,
    val lastRepetition: Repetition? = null,
    val summary: SessionSummary? = null,
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
class WorkoutViewModel : ViewModel() {
    private val poseEngine = PoseEngine()
    private val exerciseEngine = ExerciseEngine()

    private val _state = MutableStateFlow(WorkoutUiState())
    val state: StateFlow<WorkoutUiState> = _state.asStateFlow()

    fun startSession() {
        poseEngine.reset()
        exerciseEngine.reset()
        _state.value = WorkoutUiState(isRecording = true)
    }

    fun endSession() {
        if (!_state.value.isRecording) return
        val summary = exerciseEngine.summary()
        _state.update { it.copy(isRecording = false, summary = summary) }
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
}

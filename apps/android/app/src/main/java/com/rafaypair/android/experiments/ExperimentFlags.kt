package com.rafaypair.android.experiments

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The experiment flags.
 *
 * Master specification §24 names six of them and requires that no experimental
 * physiological feature be enabled silently. This registry mirrors
 * `packages/experiment-flags` name for name; `ExperimentFlagsTest` fails if a
 * name or a default drifts from it.
 */
enum class ExperimentFlag(
    val wireName: String,
    val title: String,
    val detail: String,
    /**
     * Whether the feature estimates something about the body. These may never
     * default to enabled, and the parity test enforces that.
     */
    val isPhysiological: Boolean,
) {
    CAMERA_PPG_FACE_MODE(
        "camera_ppg_face_mode",
        "Face-camera pulse",
        "Estimates a pulse from colour change in the face. Far less reliable than the " +
            "fingertip measurement, and refused outright when the lighting drifts.",
        isPhysiological = true,
    ),
    CAMERA_BREATHING_ESTIMATE(
        "camera_breathing_estimate",
        "Camera breathing estimate",
        "Estimates a breathing rate from chest movement while you are already in frame. " +
            "It says nothing rather than guessing when it cannot read you.",
        isPhysiological = true,
    ),
    MICROPHONE_BREATHING_ESTIMATE(
        "microphone_breathing_estimate",
        "Microphone breathing estimate",
        "Listens during a breathing session you started. Audio becomes a few numbers as " +
            "it arrives and is never recorded.",
        isPhysiological = true,
    ),
    ADVANCED_FORM_COACHING(
        "advanced_form_coaching",
        "Detailed form notes",
        "Comments on squat depth, forward lean, and uneven weight. Observations about " +
            "movement, not medical advice.",
        isPhysiological = false,
    ),
    LIVING_BODY_ADVANCED(
        "living_body_advanced",
        "Veins Alive",
        "An animated body view driven by what the app already knows. A visualization, " +
            "not a scan.",
        isPhysiological = false,
    ),
    AI_RELATIONSHIP_MEMORY(
        "ai_relationship_memory",
        "What Rafay remembers",
        "Lets the assistant keep notes you approve. You can read and delete every entry.",
        isPhysiological = false,
    ),
    ;

    /**
     * Every experiment ships off. One that shipped enabled would not be an
     * experiment, it would be a feature with a switch.
     */
    val enabledByDefault: Boolean get() = false

    companion object {
        fun fromWire(value: String): ExperimentFlag? = entries.firstOrNull { it.wireName == value }
    }
}

/**
 * Reads and writes the user's choices.
 *
 * Stored on the device rather than on the server: an experiment is a property of
 * this install, and syncing it would turn one device's curiosity into another
 * device's surprise.
 */
class ExperimentFlagStore(context: Context) {
    private val preferences: SharedPreferences =
        context.getSharedPreferences("rafaypair.experiments", Context.MODE_PRIVATE)

    private val mutableChoices = MutableStateFlow(readAll())
    val choices: StateFlow<Map<ExperimentFlag, Boolean>> = mutableChoices.asStateFlow()

    fun isEnabled(flag: ExperimentFlag): Boolean =
        preferences.getBoolean(storageKey(flag), flag.enabledByDefault)

    fun set(flag: ExperimentFlag, enabled: Boolean) {
        preferences.edit { putBoolean(storageKey(flag), enabled) }
        mutableChoices.value = readAll()
    }

    private fun readAll(): Map<ExperimentFlag, Boolean> =
        ExperimentFlag.entries.associateWith { isEnabled(it) }

    private fun storageKey(flag: ExperimentFlag) = "rafaypair.experiment.${flag.wireName}"
}

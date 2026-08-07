package com.rafaypair.android.physiology

/**
 * Canonical physiology types.
 *
 * Normative definitions live in `engines/signal-quality/SPEC.md`,
 * `engines/pulse-estimation-spec/SPEC.md`,
 * `engines/breathing-estimation-spec/SPEC.md`, and
 * `engines/calorie-estimation-spec/SPEC.md`. This is an independent Kotlin
 * implementation; the golden vectors in `tests/golden` hold it in agreement with
 * the Swift and TypeScript engines.
 */

enum class QualityBand(val wireName: String) {
    POOR("poor"),
    FAIR("fair"),
    GOOD("good"),
}

enum class ConfidenceBand(val wireName: String) {
    LOW("low"),
    MODERATE("moderate"),
    HIGH("high"),
}

data class SignalQuality(
    val score: Double,
    val band: QualityBand,
    val coverage: Double,
    val motion: Double,
    val periodicity: Double,
    val amplitude: Double,
    val stability: Double,
) {
    companion object {
        val EMPTY = SignalQuality(
            score = 0.0,
            band = QualityBand.POOR,
            coverage = 0.0,
            motion = 1.0,
            periodicity = 0.0,
            amplitude = 0.0,
            stability = 0.0,
        )
    }
}

/**
 * A single frame reduced to the two channel means the estimator needs. Raw
 * frames are never retained; the capture layer produces these and releases the
 * buffer.
 *
 * @property red Mean red channel over the region of interest, `0..255`.
 * @property green Mean green channel over the region of interest, `0..255`.
 */
data class PulseSample(val timestampMs: Double, val red: Double, val green: Double)

enum class PulseRejectionReason(val wireName: String) {
    TOO_SHORT("tooShort"),
    FINGER_NOT_DETECTED("fingerNotDetected"),
    EXCESSIVE_MOTION("excessiveMotion"),
    NO_PERIODICITY("noPeriodicity"),
    UNSTABLE("unstable"),
    OUT_OF_RANGE("outOfRange"),
}

/**
 * Provenance is part of the type, not a convention. There is no variant that can
 * carry a measured-grade reading, so nothing downstream can promote an estimate,
 * and no blood-pressure value is derived anywhere.
 */
sealed interface PulseResult {
    val statusName: String
    val quality: SignalQuality
    val sampleCount: Int
    val durationMs: Double

    data class Measured(
        val bpm: Double,
        override val durationMs: Double,
        override val sampleCount: Int,
        val effectiveSampleRateHz: Double,
        override val quality: SignalQuality,
        val confidence: Double,
        val confidenceBand: ConfidenceBand,
        val measuredAtMs: Double,
    ) : PulseResult {
        override val statusName = "measured"
        val source = "phone_camera_ppg"
        val kind = "app_estimated"
    }

    data class Rejected(
        val reason: PulseRejectionReason,
        override val durationMs: Double,
        override val sampleCount: Int,
        override val quality: SignalQuality,
    ) : PulseResult {
        override val statusName = "rejected"
    }
}

/**
 * One frame of the pose-derived breathing signal.
 *
 * @property chestOffset Shoulder-centre height divided by torso scale.
 * @property tracked Whether the pose engine considered the source frame valid.
 */
data class BreathingSample(
    val timestampMs: Double,
    val chestOffset: Double,
    val tracked: Boolean,
)

enum class BreathingRejectionReason(val wireName: String) {
    TOO_SHORT("tooShort"),
    NOT_TRACKED("notTracked"),
    EXCESSIVE_MOTION("excessiveMotion"),
    NO_PERIODICITY("noPeriodicity"),
    UNSTABLE("unstable"),
    OUT_OF_RANGE("outOfRange"),
}

sealed interface BreathingResult {
    val statusName: String
    val quality: SignalQuality
    val sampleCount: Int
    val durationMs: Double

    data class Measured(
        val breathsPerMinute: Double,
        override val durationMs: Double,
        override val sampleCount: Int,
        val effectiveSampleRateHz: Double,
        override val quality: SignalQuality,
        val confidence: Double,
        val confidenceBand: ConfidenceBand,
        val measuredAtMs: Double,
    ) : BreathingResult {
        override val statusName = "measured"
        val source = "phone_camera_motion"
        val kind = "app_estimated"
    }

    data class Rejected(
        val reason: BreathingRejectionReason,
        override val durationMs: Double,
        override val sampleCount: Int,
        override val quality: SignalQuality,
    ) : BreathingResult {
        override val statusName = "rejected"
    }
}

data class BreathingPattern(
    val inhaleMs: Double,
    val holdMs: Double,
    val exhaleMs: Double,
    val holdAfterMs: Double,
    val cycles: Int,
) {
    companion object {
        /** Longer exhale than inhale; the pattern that settles arousal. */
        fun calm(cycles: Int) = BreathingPattern(4000.0, 0.0, 6000.0, 0.0, cycles)

        fun box(cycles: Int) = BreathingPattern(4000.0, 4000.0, 4000.0, 4000.0, cycles)

        fun relax(cycles: Int) = BreathingPattern(4000.0, 7000.0, 8000.0, 0.0, cycles)
    }
}

enum class BreathingPhase(val wireName: String) {
    INHALE("inhale"),
    HOLD("hold"),
    EXHALE("exhale"),
    HOLD_AFTER("holdAfter"),
    COMPLETE("complete"),
}

data class BreathingPhaseState(
    val phase: BreathingPhase,
    val cycleIndex: Int,
    /** Progress through the current phase, `0..1`. Always 1 when complete. */
    val progress: Double,
    val remainingMs: Double,
)

enum class CalorieActivity(val wireName: String) {
    REST("rest"),
    GUIDED_BREATHING("guidedBreathing"),
    SQUAT("squat"),
    BODYWEIGHT_MIXED("bodyweightMixed"),
    WALKING_IN_PLACE("walkingInPlace"),
    ;

    companion object {
        fun fromWireName(value: String): CalorieActivity? =
            entries.firstOrNull { it.wireName == value }
    }
}

enum class CalorieInput(val wireName: String) {
    DURATION("duration"),
    REPETITIONS("repetitions"),
    BODY_MASS("bodyMass"),
    POSE_CONFIDENCE("poseConfidence"),
}

enum class CalorieBandLabel(val wireName: String) {
    MODERATE("moderate"),
    WIDE("wide"),
    VERY_WIDE("veryWide"),
}

data class CalorieEstimateInput(
    val activity: CalorieActivity,
    val durationMs: Double,
    val repetitions: Int? = null,
    /** Only present when the user chose to provide it. */
    val bodyMassKg: Double? = null,
    val poseConfidence: Double? = null,
)

data class CalorieEstimate(
    val estimatedKcal: Double,
    val algorithmVersion: String,
    val activity: CalorieActivity,
    val durationMs: Double,
    val repetitions: Int,
    val met: Double,
    val bodyMassKg: Double,
    val inputsUsed: List<CalorieInput>,
    val lowKcal: Double,
    val highKcal: Double,
    val bandLabel: CalorieBandLabel,
)

/** Every tunable, mirroring `packages/physiology-engine/src/constants.ts`. */
object PhysiologyTuning {
    const val RESAMPLE_HZ = 30.0
    const val RESAMPLE_STEP_MS = 1000.0 / 30.0

    const val QUALITY_GOOD_SCORE = 0.75
    const val QUALITY_FAIR_SCORE = 0.5
    const val CONFIDENCE_HIGH = 0.7
    const val CONFIDENCE_MODERATE = 0.45
    const val SUBHARMONIC_RATIO = 0.85

    const val FINGER_MIN_RED = 60.0
    const val FINGER_MAX_GREEN = 190.0
    const val FINGER_MIN_RED_EXCESS = 25.0

    const val PULSE_DETREND_WINDOW_SAMPLES = 31
    const val PULSE_SMOOTH_WINDOW_SAMPLES = 5
    const val PULSE_MIN_BPM = 42.0
    const val PULSE_MAX_BPM = 210.0

    const val PULSE_MOTION_SCALE = 6.0
    const val PULSE_STABILITY_WINDOW_SAMPLES = 150
    const val PULSE_STABILITY_STEP_SAMPLES = 45
    const val PULSE_STABILITY_SCALE = 20.0
    const val PULSE_CONFIDENCE_FULL_DURATION_MS = 20_000.0

    const val PULSE_MIN_DURATION_MS = 8_000.0
    const val PULSE_MAX_DURATION_MS = 45_000.0
    const val PULSE_MIN_COVERAGE = 0.9
    const val PULSE_MIN_PERIODICITY = 0.45
    const val PULSE_MAX_MOTION = 0.35
    const val PULSE_MIN_STABILITY = 0.3

    const val PULSE_FRESHNESS_MS = 300_000.0

    const val BREATHING_DETREND_WINDOW_SAMPLES = 301
    const val BREATHING_SMOOTH_WINDOW_SAMPLES = 25
    const val BREATHING_MIN_PER_MINUTE = 6.0
    const val BREATHING_MAX_PER_MINUTE = 36.0

    const val BREATHING_MOTION_SCALE = 0.4
    const val BREATHING_STABILITY_WINDOW_SAMPLES = 450
    const val BREATHING_STABILITY_STEP_SAMPLES = 150
    const val BREATHING_STABILITY_SCALE = 6.0
    const val BREATHING_CONFIDENCE_FULL_DURATION_MS = 45_000.0

    const val BREATHING_MIN_DURATION_MS = 20_000.0
    const val BREATHING_MIN_COVERAGE = 0.8
    const val BREATHING_MIN_PERIODICITY = 0.4
    const val BREATHING_MAX_MOTION = 0.5
    const val BREATHING_MIN_STABILITY = 0.3

    const val CALORIE_ALGORITHM_VERSION = "1.0.0"
    const val DEFAULT_BODY_MASS_KG = 70.0
    const val MET_REST = 1.3
    const val MET_GUIDED_BREATHING = 1.3
    const val MET_SQUAT = 5.0
    const val MET_BODYWEIGHT_MIXED = 4.5
    const val MET_WALKING_IN_PLACE = 3.5
    const val CALORIE_FULL_INTENSITY_REPS_PER_MINUTE = 20.0
    const val CALORIE_BASE_UNCERTAINTY = 0.25
    const val CALORIE_NO_BODY_MASS_PENALTY = 0.2
    const val CALORIE_SHORT_SESSION_PENALTY = 0.1
    const val CALORIE_LOW_CONFIDENCE_PENALTY = 0.15
    const val CALORIE_SHORT_SESSION_MS = 60_000.0
    const val CALORIE_LOW_POSE_CONFIDENCE = 0.5
    const val CALORIE_MAX_UNCERTAINTY = 0.75
}

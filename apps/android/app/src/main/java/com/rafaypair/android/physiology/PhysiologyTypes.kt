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

/**
 * Builds one breathing sample from pose landmarks.
 *
 * `engines/breathing-estimation-spec/SPEC.md` §4 is normative. Dividing by torso
 * scale makes the value invariant to distance from the camera: without it,
 * walking towards the lens would read as an inhale.
 */
object ChestSample {
    /**
     * Matched to the pose engine's own thresholds, so a frame the pose engine
     * would reject cannot enter the breathing estimator through a side door.
     */
    const val MIN_TORSO_SCALE = 0.08
    const val MIN_VISIBILITY = 0.5

    data class Point(val x: Double, val y: Double, val visibility: Double)

    fun from(
        timestampMs: Double,
        leftShoulder: Point,
        rightShoulder: Point,
        leftHip: Point,
        rightHip: Point,
    ): BreathingSample {
        val shoulderX = (leftShoulder.x + rightShoulder.x) / 2
        val shoulderY = (leftShoulder.y + rightShoulder.y) / 2
        val hipX = (leftHip.x + rightHip.x) / 2
        val hipY = (leftHip.y + rightHip.y) / 2
        val torsoScale = kotlin.math.hypot(shoulderX - hipX, shoulderY - hipY)

        val visibility = minOf(
            leftShoulder.visibility,
            rightShoulder.visibility,
            leftHip.visibility,
            rightHip.visibility,
        )
        val tracked = torsoScale >= MIN_TORSO_SCALE && visibility >= MIN_VISIBILITY

        return BreathingSample(
            timestampMs = timestampMs,
            // A frame with no usable torso has no meaningful offset; zero is
            // carried alongside `tracked = false` so the estimator drops it
            // rather than interpolating across a gap it cannot see.
            chestOffset = if (tracked) shoulderY / torsoScale else 0.0,
            tracked = tracked,
        )
    }
}

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

/**
 * One frame of the face-derived rPPG signal.
 *
 * No image is retained: the capture layer produces these six numbers and
 * releases the buffer, exactly as the fingertip path does.
 *
 * @property green Mean green channel over the facial region, `0..255`.
 * @property luma Mean brightness of the same region; drives the lighting gate.
 * @property faceArea Detected face box area as a fraction of the frame.
 */
data class FaceRppgSample(
    val timestampMs: Double,
    val green: Double,
    val luma: Double,
    val faceArea: Double,
    val faceCenterX: Double,
    val faceCenterY: Double,
)

enum class FaceRppgRejectionReason(val wireName: String) {
    TOO_SHORT("tooShort"),
    FACE_NOT_STABLE("faceNotStable"),
    UNSTABLE_LIGHTING("unstableLighting"),
    EXCESSIVE_MOTION("excessiveMotion"),
    NO_PERIODICITY("noPeriodicity"),
    UNSTABLE("unstable"),
    OUT_OF_RANGE("outOfRange"),
}

/**
 * `experimental` is fixed on the type, so no consumer can strip the caveat.
 * Specification §6 forbids this result from the heart visualization, the
 * consent-gated share, and the stored latest pulse.
 */
sealed interface FaceRppgResult {
    val statusName: String
    val quality: SignalQuality
    val sampleCount: Int
    val durationMs: Double
    val lumaSwing: Double

    data class Measured(
        val bpm: Double,
        override val durationMs: Double,
        override val sampleCount: Int,
        val effectiveSampleRateHz: Double,
        override val quality: SignalQuality,
        override val lumaSwing: Double,
        val confidence: Double,
        val confidenceBand: ConfidenceBand,
        val measuredAtMs: Double,
    ) : FaceRppgResult {
        override val statusName = "measured"
        val source = "face_camera_rppg"
        val kind = "app_estimated"
        val experimental = true
    }

    data class Rejected(
        val reason: FaceRppgRejectionReason,
        override val durationMs: Double,
        override val sampleCount: Int,
        override val quality: SignalQuality,
        override val lumaSwing: Double,
    ) : FaceRppgResult {
        override val statusName = "rejected"
    }
}

/**
 * One hop of microphone-derived features.
 *
 * This type deliberately carries no audio. It is the boundary the retention rule
 * is enforced at: three scalars at 30 Hz, from which no intelligible content is
 * reconstructible.
 */
data class AudioHopFeature(
    val timestampMs: Double,
    /** Root-mean-square energy of the band-passed hop. */
    val rms: Double,
    val zeroCrossingRate: Double,
    /** Peak absolute amplitude before filtering, used to detect clipping. */
    val peak: Double,
)

enum class AudioBreathingRejectionReason(val wireName: String) {
    TOO_SHORT("tooShort"),
    NOT_AUDIBLE("notAudible"),
    TOO_NOISY("tooNoisy"),
    NO_PERIODICITY("noPeriodicity"),
    UNSTABLE("unstable"),
    OUT_OF_RANGE("outOfRange"),
}

sealed interface AudioBreathingResult {
    val statusName: String
    val quality: SignalQuality
    val hopCount: Int
    val durationMs: Double

    data class Measured(
        val breathsPerMinute: Double,
        override val durationMs: Double,
        override val hopCount: Int,
        val effectiveSampleRateHz: Double,
        override val quality: SignalQuality,
        val confidence: Double,
        val confidenceBand: ConfidenceBand,
        val measuredAtMs: Double,
    ) : AudioBreathingResult {
        override val statusName = "measured"
        val source = "phone_microphone"
        val kind = "app_estimated"
    }

    data class Rejected(
        val reason: AudioBreathingRejectionReason,
        override val durationMs: Double,
        override val hopCount: Int,
        override val quality: SignalQuality,
    ) : AudioBreathingResult {
        override val statusName = "rejected"
    }
}

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
    /** One physical event per signal cycle — a heartbeat, a chest rise. */
    const val SUBHARMONIC_RATIO = 0.85

    /**
     * Two energy bursts per physical cycle — breath sound, loud on the inhale
     * and again on the exhale.
     */
    const val SUBHARMONIC_MARGIN = 0.02

    // Face-camera rPPG, research mode — engines/pulse-estimation-spec/FACE_RPPG.md
    /**
     * Off by default. Master specification §3.3 requires this mode to be
     * experimental and removable; the flag is the single switch.
     */
    const val FACE_RPPG_ENABLED = false

    const val FACE_DETREND_WINDOW_SAMPLES = 61
    const val FACE_SMOOTH_WINDOW_SAMPLES = 7
    const val FACE_MIN_BPM = 42.0
    const val FACE_MAX_BPM = 180.0

    const val FACE_MIN_LUMA = 60.0
    const val FACE_MAX_LUMA = 235.0
    const val FACE_MIN_AREA = 0.04
    const val FACE_MAX_CENTER_SHIFT = 0.03
    const val FACE_MAX_LUMA_SWING = 0.18

    const val FACE_MOTION_SCALE = 4.0
    const val FACE_STABILITY_WINDOW_SAMPLES = 240
    const val FACE_STABILITY_STEP_SAMPLES = 60
    const val FACE_STABILITY_SCALE = 15.0
    const val FACE_CONFIDENCE_FULL_DURATION_MS = 40_000.0

    const val FACE_MIN_DURATION_MS = 15_000.0
    const val FACE_MAX_DURATION_MS = 60_000.0

    /**
     * Stricter than the fingertip path throughout: a weaker signal earns less
     * benefit of the doubt, not more.
     */
    const val FACE_MIN_COVERAGE = 0.85
    const val FACE_MIN_PERIODICITY = 0.6
    const val FACE_MAX_MOTION = 0.3
    const val FACE_MIN_STABILITY = 0.45

    const val AUDIO_SAMPLE_RATE_HZ = 16_000.0
    const val AUDIO_HIGH_PASS_HZ = 200.0
    const val AUDIO_LOW_PASS_HZ = 2_000.0
    const val AUDIO_HOP_SAMPLES = 533

    const val AUDIO_RMS_FLOOR = 0.0015
    const val AUDIO_PEAK_CLIP = 0.98
    const val AUDIO_ZCR_MIN = 0.02
    const val AUDIO_ZCR_MAX = 0.45

    const val MIC_MOTION_SCALE = 0.05
    const val MIC_CONFIDENCE_FULL_DURATION_MS = 45_000.0
    const val MIC_MIN_DURATION_MS = 20_000.0

    /** Lower than the camera estimate: calm breathing legitimately has quiet gaps. */
    const val MIC_MIN_COVERAGE = 0.6
    const val MIC_MIN_PERIODICITY = 0.4
    const val MIC_MAX_MOTION = 0.6
    const val MIC_MIN_STABILITY = 0.3

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

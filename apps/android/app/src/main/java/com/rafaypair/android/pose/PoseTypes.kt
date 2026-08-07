package com.rafaypair.android.pose

/**
 * Canonical pose types.
 *
 * Normative definitions live in `engines/pose-spec/SPEC.md`. This is an
 * independent Kotlin implementation of that document; it shares no code with the
 * Swift or TypeScript engines, and the golden vectors in `tests/golden` are what
 * hold the three in agreement.
 */

/**
 * The thirteen joints common to Apple Vision, ML Kit Pose Detection, and
 * BlazePose. The declaration order is normative: golden vectors pack joints in
 * exactly this sequence.
 */
enum class JointName {
    NOSE,
    LEFT_SHOULDER,
    RIGHT_SHOULDER,
    LEFT_ELBOW,
    RIGHT_ELBOW,
    LEFT_WRIST,
    RIGHT_WRIST,
    LEFT_HIP,
    RIGHT_HIP,
    LEFT_KNEE,
    RIGHT_KNEE,
    LEFT_ANKLE,
    RIGHT_ANKLE,
    ;

    companion object {
        val ALL: List<JointName> = entries

        /** Joints that must all be usable for a frame to be valid. */
        val CORE: List<JointName> = listOf(
            LEFT_SHOULDER,
            RIGHT_SHOULDER,
            LEFT_HIP,
            RIGHT_HIP,
            LEFT_KNEE,
            RIGHT_KNEE,
            LEFT_ANKLE,
            RIGHT_ANKLE,
        )
    }
}

/**
 * @property x Image-normalized horizontal position; origin top-left, grows right.
 * @property y Image-normalized vertical position; origin top-left, grows down.
 * @property visibility Detector confidence in `0..1`.
 */
data class Joint(val x: Double, val y: Double, val visibility: Double)

/**
 * @property timestampMs Monotonic milliseconds.
 * @property joints Indexed by [JointName.ordinal]; always [JointName.ALL] long.
 */
data class PoseFrame(val timestampMs: Double, val joints: List<Joint>) {
    fun joint(name: JointName): Joint = joints[name.ordinal]
}

enum class Posture(val wireName: String) {
    UNKNOWN("unknown"),
    LYING("lying"),
    STANDING("standing"),
    CROUCHED("crouched"),
    TRANSITIONAL("transitional"),
}

data class PoseObservation(
    val timestampMs: Double,
    val valid: Boolean,
    val posture: Posture,
    val torsoAngleDeg: Double,
    val meanKneeAngle: Double,
    val meanHipAngle: Double,
    val leftKneeAngle: Double,
    val rightKneeAngle: Double,
    val hipElevation: Double,
    val minVisibility: Double,
    val framingOk: Boolean,
)

/** Posture as presented to the product, after temporal disambiguation. */
enum class ReportedPosture(val wireName: String) {
    UNKNOWN("unknown"),
    STANDING("standing"),
    SITTING("sitting"),
    LYING_DOWN("lyingDown"),
    SQUATTING("squatting"),
}

enum class FormEvent(val wireName: String) {
    SHALLOW_DEPTH("shallowDepth"),
    FORWARD_LEAN("forwardLean"),
    UNEVEN("uneven"),
}

data class Repetition(
    val index: Int,
    val startMs: Double,
    val endMs: Double,
    val durationMs: Double,
    val minElevation: Double,
    val depth: Double,
    val formEvents: List<FormEvent>,
)

enum class SquatPhase { IDLE, DESCENDING, BOTTOM }

data class ExerciseObservation(
    val timestampMs: Double,
    val reportedPosture: ReportedPosture,
    val squatPhase: SquatPhase,
    val repetitionCount: Int,
    /** Present only on the frame that completes a repetition. */
    val completedRepetition: Repetition?,
)

data class SessionSummary(
    val startedAtMs: Double,
    val endedAtMs: Double,
    val repetitions: List<Repetition>,
    val repetitionCount: Int,
    val bestDepth: Double,
    val averageDurationMs: Double,
    val postureTimelineMs: Map<ReportedPosture, Double>,
    val formEventCounts: Map<FormEvent, Int>,
)

/**
 * Every tunable, mirroring `packages/pose-engine/src/constants.ts`. Changing a
 * value here without changing it everywhere breaks the golden vectors, which is
 * exactly the intent.
 */
object PoseTuning {
    const val MIN_VISIBILITY = 0.5
    const val MIN_TORSO_SCALE = 0.02
    const val SMOOTHING_ALPHA = 0.4

    const val LYING_TORSO_ANGLE_DEG = 60.0
    const val STANDING_HIP_ELEVATION = 1.3
    const val STANDING_KNEE_ANGLE = 150.0
    const val CROUCHED_HIP_ELEVATION = 1.15
    const val CROUCHED_KNEE_ANGLE = 135.0

    const val SIT_HOLD_MS = 2500.0
    const val SIT_STABILITY_BAND = 0.12
    const val LIE_HOLD_MS = 1200.0
    const val STAND_HOLD_MS = 400.0

    const val SQUAT_TOP_ELEVATION = 1.3
    const val SQUAT_BOTTOM_ELEVATION = 1.05
    const val SQUAT_MIN_CYCLE_MS = 500.0
    const val SQUAT_MAX_CYCLE_MS = 8000.0

    const val STALE_FRAME_MS = 1500.0

    const val SHALLOW_DEPTH_MARGIN = 0.05
    const val FORWARD_LEAN_DEG = 45.0
    const val UNEVEN_KNEE_DEG = 25.0
}

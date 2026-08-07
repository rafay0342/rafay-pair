package com.rafaypair.android.physiology

/**
 * Veins Alive.
 *
 * Master specification §8: a visual experience, with no claim of scanning
 * veins. Nothing here measures, infers, or predicts. It turns values the
 * product already holds into the handful of numbers a renderer needs, and it is
 * a module rather than a drawing detail because one of those numbers must be
 * allowed to be absent.
 *
 * The absent one is the pulse. With no fresh estimate the animation rests: it
 * does not fall back to a plausible rate and does not keep beating at the last
 * one it saw. A vascular network pulsing at an invented 72 would be a
 * fabricated measurement wearing an animation's clothes.
 */
enum class VeinsMode(val wireName: String, val title: String, val baselineIntensity: Double) {
    CALM("calm", "Calm", 0.15),
    WORKOUT("workout", "Workout", 0.45),
    RECOVERY("recovery", "Recovery", 0.25),
}

enum class MuscleGroup(val wireName: String) {
    CHEST("chest"),
    CORE("core"),
    QUADRICEPS("quadriceps"),
    HAMSTRINGS("hamstrings"),
    GLUTES("glutes"),
    CALVES("calves"),
    SHOULDERS("shoulders"),
}

data class VeinsInput(
    val mode: VeinsMode = VeinsMode.CALM,
    /**
     * Beats per minute, and only when the estimate is still fresh. Freshness is
     * decided before the value reaches here.
     */
    val pulseBpm: Double? = null,
    /** The phase of a running guided-breathing session, or null when none is. */
    val breathingPhase: BreathingPhase? = null,
    /** Progress through that phase, 0..1. */
    val breathingProgress: Double = 0.0,
    /** Repetitions per minute in the current set, or null outside a workout. */
    val repetitionsPerMinute: Double? = null,
    val activeMuscles: List<MuscleGroup> = emptyList(),
)

enum class PulseProvenance(val wireName: String) {
    ESTIMATED("estimated"),
    NONE("none"),
}

data class VeinsDrivers(
    /**
     * Milliseconds per contraction, or null to rest. Null is the honest state,
     * not a failure: nothing current is known, so the renderer shows stillness
     * rather than motion.
     */
    val contractionPeriodMs: Double?,
    /** How the rate reached the screen. There is no `MEASURED` entry. */
    val pulseProvenance: PulseProvenance,
    val chestGlow: Double,
    val intensity: Double,
    val activeMuscles: List<MuscleGroup>,
    val disclosure: String,
)

object VeinsAlive {
    /** Shown whenever the view is on screen. Never abbreviated by a caller. */
    const val DISCLOSURE = "Sensor-driven visualization — not a medical scan."

    /** Repetitions per minute treated as full effort; above this it saturates. */
    const val REPETITIONS_AT_FULL_INTENSITY = 30.0

    fun drivers(input: VeinsInput): VeinsDrivers {
        // A rate outside what the pulse estimator itself will report is refused
        // rather than clamped: clamping would turn a wrong number into a
        // plausible one, which is the failure this module is shaped to avoid.
        val bpm = input.pulseBpm
        val usable = bpm != null && bpm.isFinite() && bpm >= 42 && bpm <= 210

        val effort = input.repetitionsPerMinute
            ?.let { clamp01(it / REPETITIONS_AT_FULL_INTENSITY) }
            ?: 0.0

        return VeinsDrivers(
            contractionPeriodMs = if (usable) 60_000.0 / bpm else null,
            pulseProvenance = if (usable) PulseProvenance.ESTIMATED else PulseProvenance.NONE,
            chestGlow = glow(input.breathingPhase, input.breathingProgress),
            intensity = clamp01(input.mode.baselineIntensity + effort * 0.55),
            activeMuscles = input.activeMuscles.distinct(),
            disclosure = DISCLOSURE,
        )
    }

    /**
     * Rises through the inhale, holds at full, falls through the exhale, and
     * rests after. Outside a session the chest does not breathe on screen while
     * the user is doing something else.
     */
    private fun glow(phase: BreathingPhase?, progress: Double): Double {
        val eased = clamp01(progress)
        return when (phase) {
            BreathingPhase.INHALE -> eased
            BreathingPhase.HOLD -> 1.0
            BreathingPhase.EXHALE -> 1.0 - eased
            BreathingPhase.HOLD_AFTER, BreathingPhase.COMPLETE, null -> 0.0
        }
    }

    private fun clamp01(value: Double): Double =
        if (!value.isFinite()) 0.0 else value.coerceIn(0.0, 1.0)
}

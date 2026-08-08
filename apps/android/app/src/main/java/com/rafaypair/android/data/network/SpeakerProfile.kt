package com.rafaypair.android.data.network

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Speaker profile — `engines/speaker-profile/SPEC.md`.
 *
 * It tells the enrolled person's voice apart from a clearly different one, so a
 * partner or a stranger speaking into the same phone does not take a turn.
 *
 * It is **not** authentication. A similar voice passes it, a recording of the
 * enrolled voice passes it, and a cold may fail it. Nothing may use it as a
 * security control and no interface may describe it as recognising who someone
 * is.
 */
object SpeakerTuning {
    const val SAMPLE_RATE_HZ = 16_000.0
    const val VOICED_MIN_RMS = 0.012
    const val F0_MIN_HZ = 70.0
    const val F0_MAX_HZ = 350.0
    const val MIN_PEAK_CORRELATION = 0.30
    const val MIN_ENROLMENT_FRAMES = 150
    const val F0_SPREAD_FLOOR = 8.0
    const val TILT_SCALE = 1.2
    const val ZCR_SCALE = 0.08
    const val MATCH_THRESHOLD = 2.6
    const val DECISION_WINDOW = 25
    const val MIN_DECIDING_FRAMES = 8
    const val REJECT_RATIO = 0.65

    const val WEIGHT_F0 = 2.0
    const val WEIGHT_TILT_MID_LOW = 1.0
    const val WEIGHT_TILT_HIGH_MID = 1.0
    const val WEIGHT_ZCR = 0.5
}

data class SpeakerFrame(
    val rms: Double,
    val f0Hz: Double,
    val tiltMidLow: Double,
    val tiltHighMid: Double,
    val zcr: Double,
)

data class SpeakerProfile(
    val f0Hz: Double,
    val f0Spread: Double,
    val tiltMidLow: Double,
    val tiltHighMid: Double,
    val zcr: Double,
    val frames: Int,
)

enum class SpeakerVerdict(val wireName: String) {
    ENROLLED("enrolled"),
    OTHER("other"),
    UNKNOWN("unknown"),
}

data class SpeakerDecision(
    val verdict: SpeakerVerdict,
    val matchRatio: Double,
    val frames: Int,
)

object SpeakerFeatures {
    private fun log2(value: Double) = ln(value) / ln(2.0)

    /**
     * One-pole low pass. Chosen over a designed filter because the recurrence is
     * exactly reproducible in three languages with no coefficient tables.
     */
    fun lowPass(samples: DoubleArray, cutoffHz: Double): DoubleArray {
        val dt = 1 / SpeakerTuning.SAMPLE_RATE_HZ
        val rc = 1 / (2 * PI * cutoffHz)
        val alpha = dt / (rc + dt)
        val out = DoubleArray(samples.size)
        var previous = 0.0
        for (index in samples.indices) {
            previous += alpha * (samples[index] - previous)
            out[index] = previous
        }
        return out
    }

    fun energy(samples: DoubleArray): Double {
        if (samples.isEmpty()) return 0.0
        var total = 0.0
        for (value in samples) total += value * value
        return total / samples.size
    }

    /**
     * Fundamental by autocorrelation, with the peak's own strength. The strength
     * is what separates a pitch from noise that happens to have a maximum
     * somewhere.
     */
    fun fundamental(samples: DoubleArray): Pair<Double, Double> {
        val minLag = (SpeakerTuning.SAMPLE_RATE_HZ / SpeakerTuning.F0_MAX_HZ).toInt()
        val maxLag = minOf(
            samples.size - 1,
            ceil(SpeakerTuning.SAMPLE_RATE_HZ / SpeakerTuning.F0_MIN_HZ).toInt(),
        )
        if (maxLag <= minLag) return 0.0 to 0.0

        var zeroLag = 0.0
        for (value in samples) zeroLag += value * value
        if (zeroLag <= 0) return 0.0 to 0.0

        var bestLag = 0
        var bestValue = 0.0
        for (lag in minLag..maxLag) {
            var sum = 0.0
            var index = 0
            while (index + lag < samples.size) {
                sum += samples[index] * samples[index + lag]
                index += 1
            }
            val normalised = sum / zeroLag
            if (normalised > bestValue) {
                bestValue = normalised
                bestLag = lag
            }
        }
        if (bestLag == 0) return 0.0 to 0.0
        return (SpeakerTuning.SAMPLE_RATE_HZ / bestLag) to bestValue
    }

    /**
     * Features for one frame, or null when it is not voiced.
     *
     * Unvoiced frames are discarded rather than given neutral values: neutral
     * values would drag every profile towards the same place and make two
     * speakers look alike.
     */
    fun frame(samples: DoubleArray): SpeakerFrame? {
        if (samples.size < 64) return null

        val rms = sqrt(energy(samples))
        if (rms < SpeakerTuning.VOICED_MIN_RMS) return null

        val (f0Hz, peak) = fundamental(samples)
        if (peak < SpeakerTuning.MIN_PEAK_CORRELATION) return null
        if (f0Hz < SpeakerTuning.F0_MIN_HZ || f0Hz > SpeakerTuning.F0_MAX_HZ) return null

        val below500 = lowPass(samples, 500.0)
        val below2000 = lowPass(samples, 2000.0)
        val lowEnergy = energy(below500)
        val midEnergy = max(0.0, energy(below2000) - lowEnergy)
        val highEnergy = max(0.0, energy(samples) - energy(below2000))

        // A floor rather than a guard: silence in one band is a real observation
        // about a voice, and log2 of zero is not.
        val floor = 1e-9
        val tiltMidLow = log2((midEnergy + floor) / (lowEnergy + floor))
        val tiltHighMid = log2((highEnergy + floor) / (midEnergy + floor))

        var crossings = 0
        for (index in 1 until samples.size) {
            val previous = samples[index - 1]
            val current = samples[index]
            if ((previous >= 0 && current < 0) || (previous < 0 && current >= 0)) {
                crossings += 1
            }
        }

        return SpeakerFrame(
            rms = rms,
            f0Hz = f0Hz,
            tiltMidLow = tiltMidLow,
            tiltHighMid = tiltHighMid,
            zcr = crossings.toDouble() / samples.size,
        )
    }

    private fun median(values: List<Double>): Double {
        val sorted = values.sorted()
        val middle = sorted.size / 2
        return if (sorted.size % 2 == 1) sorted[middle] else (sorted[middle - 1] + sorted[middle]) / 2
    }

    private fun mean(values: List<Double>): Double =
        if (values.isEmpty()) 0.0 else values.sum() / values.size

    /**
     * Builds a profile, or null when there is not enough voiced speech. Too
     * little produces nothing rather than something weak: a weak profile does
     * not fail loudly, it quietly matches everyone.
     */
    fun profile(frames: List<SpeakerFrame>): SpeakerProfile? {
        if (frames.size < SpeakerTuning.MIN_ENROLMENT_FRAMES) return null

        val f0Values = frames.map { it.f0Hz }
        val centre = median(f0Values)
        // Median absolute deviation, not standard deviation: one shouted word
        // should not move a profile.
        val spread = max(SpeakerTuning.F0_SPREAD_FLOOR, median(f0Values.map { abs(it - centre) }))

        return SpeakerProfile(
            f0Hz = centre,
            f0Spread = spread,
            tiltMidLow = mean(frames.map { it.tiltMidLow }),
            tiltHighMid = mean(frames.map { it.tiltHighMid }),
            zcr = mean(frames.map { it.zcr }),
            frames = frames.size,
        )
    }

    /** Distance in units of the enrolled speaker's own variation. */
    fun distance(frame: SpeakerFrame, profile: SpeakerProfile): Double {
        val d0 = abs(frame.f0Hz - profile.f0Hz) / profile.f0Spread
        val d1 = abs(frame.tiltMidLow - profile.tiltMidLow) / SpeakerTuning.TILT_SCALE
        val d2 = abs(frame.tiltHighMid - profile.tiltHighMid) / SpeakerTuning.TILT_SCALE
        val d3 = abs(frame.zcr - profile.zcr) / SpeakerTuning.ZCR_SCALE
        return sqrt(
            SpeakerTuning.WEIGHT_F0 * d0 * d0 +
                SpeakerTuning.WEIGHT_TILT_MID_LOW * d1 * d1 +
                SpeakerTuning.WEIGHT_TILT_HIGH_MID * d2 * d2 +
                SpeakerTuning.WEIGHT_ZCR * d3 * d3,
        )
    }
}

/**
 * Answers on the balance of a short history, never on one frame.
 *
 * UNKNOWN is a real answer and callers must transmit on it: being unheard is
 * worse than occasionally answering someone else.
 */
class SpeakerMatcher(private val profile: SpeakerProfile?) {
    private val history = ArrayDeque<Boolean>()

    /** Every frame is offered; only voiced ones reach a verdict. */
    fun accept(frame: SpeakerFrame?): SpeakerDecision {
        if (profile != null && frame != null) {
            history.addLast(SpeakerFeatures.distance(frame, profile) <= SpeakerTuning.MATCH_THRESHOLD)
            if (history.size > SpeakerTuning.DECISION_WINDOW) history.removeFirst()
        }

        val frames = history.size
        if (profile == null || frames < SpeakerTuning.MIN_DECIDING_FRAMES) {
            return SpeakerDecision(SpeakerVerdict.UNKNOWN, 1.0, frames)
        }

        val matchRatio = history.count { it }.toDouble() / frames
        return SpeakerDecision(
            verdict = if (1 - matchRatio >= SpeakerTuning.REJECT_RATIO) {
                SpeakerVerdict.OTHER
            } else {
                SpeakerVerdict.ENROLLED
            },
            matchRatio = matchRatio,
            frames = frames,
        )
    }

    fun reset() = history.clear()
}

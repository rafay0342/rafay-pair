package com.rafaypair.android.physiology

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong
import kotlin.math.sqrt

/**
 * The shared periodic-signal core — Kotlin implementation of
 * `engines/signal-quality/SPEC.md`.
 *
 * Summation order is part of the contract: every loop accumulates in increasing
 * index order so that the TypeScript and Swift engines reproduce the same
 * rounding.
 */
object SignalCore {
    /**
     * Which way the signal's harmonics fold, and therefore how an ambiguous
     * correlation peak is resolved. See [PhysiologyTuning] for the physics.
     */
    enum class HarmonicFold { SIGNAL_PER_CYCLE, ENERGY_PER_HALF_CYCLE }

    data class TimedSample(val timestampMs: Double, val value: Double)

    /**
     * @property periodicity Correlation at the chosen lag, floored at zero.
     * @property refinedLag Sub-sample refined lag, or `null` when the band does
     *   not fit.
     */
    data class Periodicity(val periodicity: Double, val refinedLag: Double?)

    data class StabilityOptions(
        val windowSamples: Int,
        val stepSamples: Int,
        val scale: Double,
        val minLag: Int,
        val maxLag: Int,
        val fold: HarmonicFold = HarmonicFold.SIGNAL_PER_CYCLE,
    )

    fun clamp(value: Double, low: Double, high: Double): Double = when {
        value < low -> low
        value > high -> high
        else -> value
    }

    /** Rounds to one decimal, half away from zero. Values here are never negative. */
    fun roundToTenth(value: Double): Double = (value * 10).roundToLong() / 10.0

    /** Drops samples whose timestamp does not advance, as the specification requires. */
    fun <T> monotonic(samples: List<T>, timestamp: (T) -> Double): List<T> {
        val ordered = mutableListOf<T>()
        for (sample in samples) {
            val previous = ordered.lastOrNull()
            if (previous != null && timestamp(sample) <= timestamp(previous)) continue
            ordered.add(sample)
        }
        return ordered
    }

    /**
     * Linear resampling onto a uniform 30 Hz grid starting at the first
     * timestamp. Camera delivery is irregular and every later stage assumes a
     * fixed step, so the irregularity is resolved once, here.
     */
    fun resample(samples: List<TimedSample>): DoubleArray {
        if (samples.size < 2) return DoubleArray(samples.size) { samples[it].value }

        val first = samples[0]
        val last = samples[samples.size - 1]
        val spanMs = last.timestampMs - first.timestampMs
        val count = floor(spanMs / PhysiologyTuning.RESAMPLE_STEP_MS).toInt() + 1

        val values = DoubleArray(count)
        var cursor = 0
        for (index in 0 until count) {
            val target = first.timestampMs + index * PhysiologyTuning.RESAMPLE_STEP_MS
            while (cursor < samples.size - 2 && samples[cursor + 1].timestampMs < target) {
                cursor += 1
            }
            val left = samples[cursor]
            val right = samples[cursor + 1]
            val width = right.timestampMs - left.timestampMs
            val ratio = if (width <= 0) 0.0 else (target - left.timestampMs) / width
            values[index] = left.value + (right.value - left.value) * clamp(ratio, 0.0, 1.0)
        }
        return values
    }

    /**
     * Centred moving average with edge truncation: at the edges only the samples
     * that exist are averaged. No padding and no reflection, so the operation is
     * fully specified.
     */
    fun movingAverage(values: DoubleArray, window: Int): DoubleArray {
        if (window <= 1) return values.copyOf()
        val half = window / 2
        val averaged = DoubleArray(values.size)
        for (index in values.indices) {
            val start = max(0, index - half)
            val end = min(values.size - 1, index + half)
            var total = 0.0
            for (cursor in start..end) total += values[cursor]
            averaged[index] = total / (end - start + 1)
        }
        return averaged
    }

    /**
     * Normalized autocorrelation over a lag band, with subharmonic suppression
     * and parabolic peak refinement.
     */
    fun periodicity(
        filtered: DoubleArray,
        minLag: Int,
        maxLag: Int,
        fold: HarmonicFold = HarmonicFold.SIGNAL_PER_CYCLE,
    ): Periodicity {
        if (filtered.size <= minLag + 1 || minLag < 1 || maxLag < minLag) {
            return Periodicity(0.0, null)
        }
        val highestLag = min(maxLag, filtered.size - 2)
        if (highestLag < minLag) return Periodicity(0.0, null)

        val correlations = DoubleArray(highestLag - minLag + 1)
        for (lag in minLag..highestLag) {
            correlations[lag - minLag] = correlationAt(filtered, lag)
        }

        var bestIndex = 0
        for (index in 1 until correlations.size) {
            if (correlations[index] > correlations[bestIndex]) bestIndex = index
        }

        // Autocorrelation peaks just as strongly at whole multiples of the true
        // period, so an unguarded maximum reports half or a third of the real
        // rate. Which way to resolve the ambiguity depends on the signal's
        // physics, so the caller declares it: a heartbeat produces one cycle per
        // event, while breath sound produces two energy bursts per cycle and its
        // half-lag therefore always correlates well.
        val peakIndex = bestIndex
        val peak = correlations[peakIndex]
        for (divisor in intArrayOf(3, 2)) {
            val candidateLag = ((minLag + peakIndex).toDouble() / divisor).roundToInt()
            val candidateIndex = candidateLag - minLag
            if (candidateIndex < 0 || candidateIndex >= correlations.size) continue
            val candidate = correlations[candidateIndex]
            val wins = if (fold == HarmonicFold.SIGNAL_PER_CYCLE) {
                candidate >= PhysiologyTuning.SUBHARMONIC_RATIO * peak
            } else {
                candidate >= peak - PhysiologyTuning.SUBHARMONIC_MARGIN
            }
            if (wins) {
                bestIndex = candidateIndex
                break
            }
        }

        val best = correlations[bestIndex]
        val bestLag = minLag + bestIndex

        var offset = 0.0
        if (bestIndex > 0 && bestIndex < correlations.size - 1) {
            val before = correlations[bestIndex - 1]
            val after = correlations[bestIndex + 1]
            val denominator = before - 2 * best + after
            // Without the clamp a nearly flat correlation curve produces an
            // enormous offset and a fabricated rate.
            offset = if (abs(denominator) < 1e-12) {
                0.0
            } else {
                clamp((0.5 * (before - after)) / denominator, -0.5, 0.5)
            }
        }

        return Periodicity(max(0.0, best), bestLag + offset)
    }

    private fun correlationAt(values: DoubleArray, lag: Int): Double {
        var cross = 0.0
        var energyA = 0.0
        var energyB = 0.0
        var index = 0
        while (index + lag < values.size) {
            val a = values[index]
            val b = values[index + lag]
            cross += a * b
            energyA += a * a
            energyB += b * b
            index += 1
        }
        val denominator = sqrt(energyA * energyB)
        return if (denominator < 1e-12) 0.0 else cross / denominator
    }

    fun ratePerMinuteFromLag(lag: Double): Double = (60 * PhysiologyTuning.RESAMPLE_HZ) / lag

    /** Mean absolute first difference of the resampled signal, scaled and clamped. */
    fun motion(resampled: DoubleArray, scale: Double): Double {
        if (resampled.size < 2) return 1.0
        var total = 0.0
        for (index in 1 until resampled.size) {
            total += abs(resampled[index] - resampled[index - 1])
        }
        return min(1.0, total / (resampled.size - 1) / scale)
    }

    /** Nearest-rank percentile, which needs no interpolation convention. */
    fun percentile(values: DoubleArray, fraction: Double): Double {
        if (values.isEmpty()) return 0.0
        val sorted = values.copyOf()
        sorted.sort()
        val index = floor(fraction * (sorted.size - 1)).toInt()
        return sorted[index]
    }

    fun amplitude(filtered: DoubleArray, resampled: DoubleArray): Double {
        if (filtered.isEmpty()) return 0.0
        var total = 0.0
        for (value in resampled) total += value
        val mean = if (resampled.isEmpty()) 0.0 else total / resampled.size
        val span = percentile(filtered, 0.95) - percentile(filtered, 0.05)
        return span / max(abs(mean), 1e-6)
    }

    /**
     * Spread of per-window rates, mapped to `0..1`. When the signal is too short
     * to fit two windows the result is zero: a session that cannot demonstrate
     * stability does not get to claim it.
     */
    fun stability(filtered: DoubleArray, options: StabilityOptions): Double {
        val rates = mutableListOf<Double>()
        var start = 0
        while (start + options.windowSamples <= filtered.size) {
            val window = filtered.copyOfRange(start, start + options.windowSamples)
            val result = periodicity(window, options.minLag, options.maxLag, options.fold)
            result.refinedLag?.let { rates.add(ratePerMinuteFromLag(it)) }
            start += options.stepSamples
        }
        if (rates.size < 2) return 0.0

        var lowest = rates[0]
        var highest = rates[0]
        for (rate in rates) {
            if (rate < lowest) lowest = rate
            if (rate > highest) highest = rate
        }
        return 1 - min(1.0, (highest - lowest) / options.scale)
    }

    fun qualityBand(score: Double): QualityBand = when {
        score >= PhysiologyTuning.QUALITY_GOOD_SCORE -> QualityBand.GOOD
        score >= PhysiologyTuning.QUALITY_FAIR_SCORE -> QualityBand.FAIR
        else -> QualityBand.POOR
    }

    fun confidence(
        periodicity: Double,
        stability: Double,
        durationMs: Double,
        fullDurationMs: Double,
    ): Double {
        val durationFactor = clamp(durationMs / fullDurationMs, 0.0, 1.0)
        return clamp(0.5 * periodicity + 0.3 * stability + 0.2 * durationFactor, 0.0, 1.0)
    }

    fun confidenceBand(confidence: Double): ConfidenceBand = when {
        confidence >= PhysiologyTuning.CONFIDENCE_HIGH -> ConfidenceBand.HIGH
        confidence >= PhysiologyTuning.CONFIDENCE_MODERATE -> ConfidenceBand.MODERATE
        else -> ConfidenceBand.LOW
    }

    fun effectiveSampleRateHz(sampleCount: Int, durationMs: Double): Double {
        if (sampleCount < 2 || durationMs <= 0) return 0.0
        return ((sampleCount - 1) * 1000.0) / durationMs
    }
}

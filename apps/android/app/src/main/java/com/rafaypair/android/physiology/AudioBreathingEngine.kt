package com.rafaypair.android.physiology

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Microphone breathing rhythm — Kotlin implementation of
 * `engines/breathing-estimation-spec/MICROPHONE.md` (master specification §6C).
 *
 * Raw audio never reaches the estimator. Its input carries only per-hop features
 * — a band energy, a zero-crossing rate, and a peak level — from which speech is
 * not reconstructible. That is the retention rule made structural rather than
 * promised.
 */
object AudioBreathingEstimator {
    private val minLag =
        ((60 * PhysiologyTuning.RESAMPLE_HZ) / PhysiologyTuning.BREATHING_MAX_PER_MINUTE)
            .roundToInt()
    private val maxLag =
        ((60 * PhysiologyTuning.RESAMPLE_HZ) / PhysiologyTuning.BREATHING_MIN_PER_MINUTE)
            .roundToInt()

    /**
     * Converts a block of microphone samples into per-hop features.
     *
     * This is the only function that ever sees audio, and it returns numbers
     * rather than a signal. The band-pass is a cascade of two one-pole filters,
     * chosen because a one-pole recurrence is exactly reproducible in three
     * languages with no filter-design library and no coefficient tables.
     *
     * @param samples floating point in `-1..1`
     */
    fun extractHops(samples: DoubleArray, startTimestampMs: Double): List<AudioHopFeature> {
        val highPassAlpha = 1 /
            (
                1 + (2 * PI * PhysiologyTuning.AUDIO_HIGH_PASS_HZ) /
                    PhysiologyTuning.AUDIO_SAMPLE_RATE_HZ
                )
        val lowPassOmega = (2 * PI * PhysiologyTuning.AUDIO_LOW_PASS_HZ) /
            PhysiologyTuning.AUDIO_SAMPLE_RATE_HZ
        val lowPassAlpha = lowPassOmega / (1 + lowPassOmega)

        val hops = mutableListOf<AudioHopFeature>()
        var previousRaw = 0.0
        var previousHighPassed = 0.0
        var banded = 0.0

        // A trailing partial hop is discarded rather than padded: padding would
        // invent a quieter hop and drag the envelope down exactly when a session
        // ends.
        val hopSamples = PhysiologyTuning.AUDIO_HOP_SAMPLES
        val hopCount = samples.size / hopSamples
        var cursor = 0

        for (hop in 0 until hopCount) {
            var energy = 0.0
            var crossings = 0
            var peak = 0.0
            var previousBanded = banded

            for (index in 0 until hopSamples) {
                val raw = samples[cursor]
                cursor += 1

                val highPassed = highPassAlpha * (previousHighPassed + raw - previousRaw)
                banded += lowPassAlpha * (highPassed - banded)
                previousRaw = raw
                previousHighPassed = highPassed

                energy += banded * banded
                val magnitude = abs(raw)
                if (magnitude > peak) peak = magnitude
                if (index > 0 && signOf(previousBanded) * signOf(banded) < 0) {
                    crossings += 1
                }
                previousBanded = banded
            }

            hops.add(
                AudioHopFeature(
                    timestampMs = startTimestampMs +
                        (hop.toDouble() * hopSamples * 1000) /
                        PhysiologyTuning.AUDIO_SAMPLE_RATE_HZ,
                    rms = sqrt(energy / hopSamples),
                    zeroCrossingRate = crossings.toDouble() / (hopSamples - 1),
                    peak = peak,
                ),
            )
        }
        return hops
    }

    private fun signOf(value: Double): Double = when {
        value > 0 -> 1.0
        value < 0 -> -1.0
        else -> 0.0
    }

    /**
     * A hop is usable when it is audible, unclipped, and its zero-crossing rate
     * looks like broadband turbulence rather than voiced speech (too periodic) or
     * hiss (too dense).
     */
    fun isHopUsable(hop: AudioHopFeature): Boolean =
        hop.rms >= PhysiologyTuning.AUDIO_RMS_FLOOR &&
            hop.peak < PhysiologyTuning.AUDIO_PEAK_CLIP &&
            hop.zeroCrossingRate >= PhysiologyTuning.AUDIO_ZCR_MIN &&
            hop.zeroCrossingRate <= PhysiologyTuning.AUDIO_ZCR_MAX

    fun estimate(hops: List<AudioHopFeature>, measuredAtMs: Double): AudioBreathingResult {
        val ordered = SignalCore.monotonic(hops) { it.timestampMs }
        val hopCount = ordered.size
        val durationMs = if (hopCount < 2) {
            0.0
        } else {
            ordered[hopCount - 1].timestampMs - ordered[0].timestampMs
        }

        if (hopCount < 2 || durationMs < PhysiologyTuning.MIC_MIN_DURATION_MS) {
            return AudioBreathingResult.Rejected(
                AudioBreathingRejectionReason.TOO_SHORT, durationMs, hopCount,
                SignalQuality.EMPTY,
            )
        }

        var usable = 0
        for (hop in ordered) if (isHopUsable(hop)) usable += 1
        val coverage = usable.toDouble() / hopCount

        // Unusable hops still contribute their energy: removing them would punch
        // holes in the envelope that the autocorrelation would read as rhythm.
        val resampled = SignalCore.resample(
            ordered.map { SignalCore.TimedSample(it.timestampMs, it.rms) },
        )
        val baseline = SignalCore.movingAverage(
            resampled, PhysiologyTuning.BREATHING_DETREND_WINDOW_SAMPLES,
        )
        val detrended = DoubleArray(resampled.size) { resampled[it] - baseline[it] }
        val filtered = SignalCore.movingAverage(
            detrended, PhysiologyTuning.BREATHING_SMOOTH_WINDOW_SAMPLES,
        )

        val result = SignalCore.periodicity(
            filtered, minLag, maxLag, SignalCore.HarmonicFold.ENERGY_PER_HALF_CYCLE,
        )
        val motion = SignalCore.motion(resampled, PhysiologyTuning.MIC_MOTION_SCALE)
        val stability = SignalCore.stability(
            filtered,
            SignalCore.StabilityOptions(
                windowSamples = PhysiologyTuning.BREATHING_STABILITY_WINDOW_SAMPLES,
                stepSamples = PhysiologyTuning.BREATHING_STABILITY_STEP_SAMPLES,
                scale = PhysiologyTuning.BREATHING_STABILITY_SCALE,
                minLag = minLag,
                maxLag = maxLag,
                fold = SignalCore.HarmonicFold.ENERGY_PER_HALF_CYCLE,
            ),
        )
        val amplitude = SignalCore.amplitude(filtered, resampled)

        val score =
            0.4 * result.periodicity + 0.25 * coverage + 0.2 * stability + 0.15 * (1 - motion)
        val quality = SignalQuality(
            score = score,
            band = SignalCore.qualityBand(score),
            coverage = coverage,
            motion = motion,
            periodicity = result.periodicity,
            amplitude = amplitude,
            stability = stability,
        )

        if (coverage < PhysiologyTuning.MIC_MIN_COVERAGE) {
            return AudioBreathingResult.Rejected(
                AudioBreathingRejectionReason.NOT_AUDIBLE, durationMs, hopCount, quality,
            )
        }
        if (motion > PhysiologyTuning.MIC_MAX_MOTION) {
            return AudioBreathingResult.Rejected(
                AudioBreathingRejectionReason.TOO_NOISY, durationMs, hopCount, quality,
            )
        }
        val refinedLag = result.refinedLag
        if (result.periodicity < PhysiologyTuning.MIC_MIN_PERIODICITY || refinedLag == null) {
            return AudioBreathingResult.Rejected(
                AudioBreathingRejectionReason.NO_PERIODICITY, durationMs, hopCount, quality,
            )
        }
        if (stability < PhysiologyTuning.MIC_MIN_STABILITY) {
            return AudioBreathingResult.Rejected(
                AudioBreathingRejectionReason.UNSTABLE, durationMs, hopCount, quality,
            )
        }

        val rate = SignalCore.roundToTenth(SignalCore.ratePerMinuteFromLag(refinedLag))
        if (rate < PhysiologyTuning.BREATHING_MIN_PER_MINUTE ||
            rate > PhysiologyTuning.BREATHING_MAX_PER_MINUTE
        ) {
            return AudioBreathingResult.Rejected(
                AudioBreathingRejectionReason.OUT_OF_RANGE, durationMs, hopCount, quality,
            )
        }

        val confidence = SignalCore.confidence(
            periodicity = result.periodicity,
            stability = stability,
            durationMs = durationMs,
            fullDurationMs = PhysiologyTuning.MIC_CONFIDENCE_FULL_DURATION_MS,
        )

        return AudioBreathingResult.Measured(
            breathsPerMinute = rate,
            durationMs = durationMs,
            hopCount = hopCount,
            effectiveSampleRateHz = SignalCore.effectiveSampleRateHz(hopCount, durationMs),
            quality = quality,
            confidence = confidence,
            confidenceBand = SignalCore.confidenceBand(confidence),
            measuredAtMs = measuredAtMs,
        )
    }
}

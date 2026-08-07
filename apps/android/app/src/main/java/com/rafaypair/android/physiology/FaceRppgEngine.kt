package com.rafaypair.android.physiology

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Face-camera pulse, research mode — Kotlin implementation of
 * `engines/pulse-estimation-spec/FACE_RPPG.md` (master specification §3.3).
 *
 * Experimental by construction. Specification §6 forbids this result from
 * feeding the heart visualization, the consent-gated share, or the stored latest
 * pulse. Nothing outside this file and its own surface references it, which is
 * what makes the mode removable without breaking the application.
 */
object FaceRppgEstimator {
    private val minLag =
        ((60 * PhysiologyTuning.RESAMPLE_HZ) / PhysiologyTuning.FACE_MAX_BPM).roundToInt()
    private val maxLag =
        ((60 * PhysiologyTuning.RESAMPLE_HZ) / PhysiologyTuning.FACE_MIN_BPM).roundToInt()

    fun estimate(samples: List<FaceRppgSample>, measuredAtMs: Double): FaceRppgResult {
        val ordered = trimToWindow(SignalCore.monotonic(samples) { it.timestampMs })
        val sampleCount = ordered.size
        val durationMs = if (sampleCount < 2) {
            0.0
        } else {
            ordered[sampleCount - 1].timestampMs - ordered[0].timestampMs
        }

        if (sampleCount < 2 || durationMs < PhysiologyTuning.FACE_MIN_DURATION_MS) {
            return FaceRppgResult.Rejected(
                FaceRppgRejectionReason.TOO_SHORT, durationMs, sampleCount,
                SignalQuality.EMPTY, 0.0,
            )
        }

        val coverage = coverageOf(ordered)
        val lumaSwing = lumaSwingOf(ordered)

        // Haemoglobin absorbs green most strongly, which is why the green
        // channel rather than the red one carries the pulsatile component
        // through skin.
        val resampled = SignalCore.resample(
            ordered.map { SignalCore.TimedSample(it.timestampMs, it.green) },
        )
        val baseline = SignalCore.movingAverage(
            resampled, PhysiologyTuning.FACE_DETREND_WINDOW_SAMPLES,
        )
        val detrended = DoubleArray(resampled.size) { resampled[it] - baseline[it] }
        val filtered = SignalCore.movingAverage(
            detrended, PhysiologyTuning.FACE_SMOOTH_WINDOW_SAMPLES,
        )

        val result = SignalCore.periodicity(filtered, minLag, maxLag)
        val motion = SignalCore.motion(resampled, PhysiologyTuning.FACE_MOTION_SCALE)
        val stability = SignalCore.stability(
            filtered,
            SignalCore.StabilityOptions(
                windowSamples = PhysiologyTuning.FACE_STABILITY_WINDOW_SAMPLES,
                stepSamples = PhysiologyTuning.FACE_STABILITY_STEP_SAMPLES,
                scale = PhysiologyTuning.FACE_STABILITY_SCALE,
                minLag = minLag,
                maxLag = maxLag,
            ),
        )
        val amplitude = SignalCore.amplitude(filtered, resampled)

        val score =
            0.4 * result.periodicity + 0.2 * coverage + 0.2 * stability + 0.2 * (1 - motion)
        val quality = SignalQuality(
            score = score,
            band = SignalCore.qualityBand(score),
            coverage = coverage,
            motion = motion,
            periodicity = result.periodicity,
            amplitude = amplitude,
            stability = stability,
        )

        if (coverage < PhysiologyTuning.FACE_MIN_COVERAGE) {
            return FaceRppgResult.Rejected(
                FaceRppgRejectionReason.FACE_NOT_STABLE, durationMs, sampleCount,
                quality, lumaSwing,
            )
        }
        // Changing light produces exactly the slow brightness oscillation an
        // rPPG estimator mistakes for a pulse. The torch removes this problem on
        // the fingertip path; here it has to be caught.
        if (lumaSwing > PhysiologyTuning.FACE_MAX_LUMA_SWING) {
            return FaceRppgResult.Rejected(
                FaceRppgRejectionReason.UNSTABLE_LIGHTING, durationMs, sampleCount,
                quality, lumaSwing,
            )
        }
        if (motion > PhysiologyTuning.FACE_MAX_MOTION) {
            return FaceRppgResult.Rejected(
                FaceRppgRejectionReason.EXCESSIVE_MOTION, durationMs, sampleCount,
                quality, lumaSwing,
            )
        }
        val refinedLag = result.refinedLag
        if (result.periodicity < PhysiologyTuning.FACE_MIN_PERIODICITY || refinedLag == null) {
            return FaceRppgResult.Rejected(
                FaceRppgRejectionReason.NO_PERIODICITY, durationMs, sampleCount,
                quality, lumaSwing,
            )
        }
        if (stability < PhysiologyTuning.FACE_MIN_STABILITY) {
            return FaceRppgResult.Rejected(
                FaceRppgRejectionReason.UNSTABLE, durationMs, sampleCount,
                quality, lumaSwing,
            )
        }

        val bpm = SignalCore.roundToTenth(SignalCore.ratePerMinuteFromLag(refinedLag))
        if (bpm < PhysiologyTuning.FACE_MIN_BPM || bpm > PhysiologyTuning.FACE_MAX_BPM) {
            return FaceRppgResult.Rejected(
                FaceRppgRejectionReason.OUT_OF_RANGE, durationMs, sampleCount,
                quality, lumaSwing,
            )
        }

        val confidence = SignalCore.confidence(
            periodicity = result.periodicity,
            stability = stability,
            durationMs = durationMs,
            fullDurationMs = PhysiologyTuning.FACE_CONFIDENCE_FULL_DURATION_MS,
        )

        return FaceRppgResult.Measured(
            bpm = bpm,
            durationMs = durationMs,
            sampleCount = sampleCount,
            effectiveSampleRateHz = SignalCore.effectiveSampleRateHz(sampleCount, durationMs),
            quality = quality,
            lumaSwing = lumaSwing,
            confidence = confidence,
            confidenceBand = SignalCore.confidenceBand(confidence),
            measuredAtMs = measuredAtMs,
        )
    }

    private fun trimToWindow(samples: List<FaceRppgSample>): List<FaceRppgSample> {
        if (samples.size < 2) return samples
        val cutoff =
            samples[samples.size - 1].timestampMs - PhysiologyTuning.FACE_MAX_DURATION_MS
        return samples.filter { it.timestampMs >= cutoff }
    }

    /**
     * A frame is usable when the face is present, lit within the sensor's usable
     * range, and has not jumped since the previous usable frame.
     */
    private fun coverageOf(samples: List<FaceRppgSample>): Double {
        if (samples.isEmpty()) return 0.0
        var usable = 0
        var previous: FaceRppgSample? = null
        for (sample in samples) {
            val lit = sample.luma >= PhysiologyTuning.FACE_MIN_LUMA &&
                sample.luma <= PhysiologyTuning.FACE_MAX_LUMA
            val present = sample.faceArea >= PhysiologyTuning.FACE_MIN_AREA
            val reference = previous
            val still = reference == null ||
                (
                    abs(sample.faceCenterX - reference.faceCenterX) <
                        PhysiologyTuning.FACE_MAX_CENTER_SHIFT &&
                        abs(sample.faceCenterY - reference.faceCenterY) <
                        PhysiologyTuning.FACE_MAX_CENTER_SHIFT
                    )
            if (lit && present && still) {
                usable += 1
                previous = sample
            }
        }
        return usable.toDouble() / samples.size
    }

    private fun lumaSwingOf(samples: List<FaceRppgSample>): Double {
        var lowest = Double.POSITIVE_INFINITY
        var highest = Double.NEGATIVE_INFINITY
        var total = 0.0
        for (sample in samples) {
            if (sample.luma < lowest) lowest = sample.luma
            if (sample.luma > highest) highest = sample.luma
            total += sample.luma
        }
        val mean = total / samples.size
        return (highest - lowest) / max(mean, 1.0)
    }
}

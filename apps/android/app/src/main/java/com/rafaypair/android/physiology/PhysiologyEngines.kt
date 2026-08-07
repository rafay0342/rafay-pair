package com.rafaypair.android.physiology

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Finger-camera pulse estimation — Kotlin implementation of
 * `engines/pulse-estimation-spec/SPEC.md`.
 *
 * Produces a real number from a real signal, and refuses to produce one
 * otherwise. No blood-pressure value is derived here or anywhere else.
 */
object PulseEstimator {
    private val minLag =
        ((60 * PhysiologyTuning.RESAMPLE_HZ) / PhysiologyTuning.PULSE_MAX_BPM).roundToInt()
    private val maxLag =
        ((60 * PhysiologyTuning.RESAMPLE_HZ) / PhysiologyTuning.PULSE_MIN_BPM).roundToInt()

    fun estimate(samples: List<PulseSample>, measuredAtMs: Double): PulseResult {
        val ordered = trimToWindow(SignalCore.monotonic(samples) { it.timestampMs })
        val sampleCount = ordered.size
        val durationMs = if (sampleCount < 2) {
            0.0
        } else {
            ordered[sampleCount - 1].timestampMs - ordered[0].timestampMs
        }

        if (sampleCount < 2 || durationMs < PhysiologyTuning.PULSE_MIN_DURATION_MS) {
            return PulseResult.Rejected(
                PulseRejectionReason.TOO_SHORT, durationMs, sampleCount, SignalQuality.EMPTY,
            )
        }

        val coverage = coverageOf(ordered)
        val resampled = SignalCore.resample(
            ordered.map { SignalCore.TimedSample(it.timestampMs, it.red) },
        )
        val baseline = SignalCore.movingAverage(
            resampled, PhysiologyTuning.PULSE_DETREND_WINDOW_SAMPLES,
        )
        val detrended = DoubleArray(resampled.size) { resampled[it] - baseline[it] }
        val filtered = SignalCore.movingAverage(
            detrended, PhysiologyTuning.PULSE_SMOOTH_WINDOW_SAMPLES,
        )

        val result = SignalCore.periodicity(filtered, minLag, maxLag)
        val motion = SignalCore.motion(resampled, PhysiologyTuning.PULSE_MOTION_SCALE)
        val stability = SignalCore.stability(
            filtered,
            SignalCore.StabilityOptions(
                windowSamples = PhysiologyTuning.PULSE_STABILITY_WINDOW_SAMPLES,
                stepSamples = PhysiologyTuning.PULSE_STABILITY_STEP_SAMPLES,
                scale = PhysiologyTuning.PULSE_STABILITY_SCALE,
                minLag = minLag,
                maxLag = maxLag,
            ),
        )
        val amplitude = SignalCore.amplitude(filtered, resampled)

        val score =
            0.35 * result.periodicity + 0.25 * coverage + 0.2 * stability + 0.2 * (1 - motion)
        val quality = SignalQuality(
            score = score,
            band = SignalCore.qualityBand(score),
            coverage = coverage,
            motion = motion,
            periodicity = result.periodicity,
            amplitude = amplitude,
            stability = stability,
        )

        // Ordering is normative: the reason is shown to the user and must name
        // the first thing they can act on.
        if (coverage < PhysiologyTuning.PULSE_MIN_COVERAGE) {
            return PulseResult.Rejected(
                PulseRejectionReason.FINGER_NOT_DETECTED, durationMs, sampleCount, quality,
            )
        }
        if (motion > PhysiologyTuning.PULSE_MAX_MOTION) {
            return PulseResult.Rejected(
                PulseRejectionReason.EXCESSIVE_MOTION, durationMs, sampleCount, quality,
            )
        }
        val refinedLag = result.refinedLag
        if (result.periodicity < PhysiologyTuning.PULSE_MIN_PERIODICITY || refinedLag == null) {
            return PulseResult.Rejected(
                PulseRejectionReason.NO_PERIODICITY, durationMs, sampleCount, quality,
            )
        }
        // A strong but drifting peak is not a pulse.
        if (stability < PhysiologyTuning.PULSE_MIN_STABILITY) {
            return PulseResult.Rejected(
                PulseRejectionReason.UNSTABLE, durationMs, sampleCount, quality,
            )
        }

        val bpm = SignalCore.roundToTenth(SignalCore.ratePerMinuteFromLag(refinedLag))
        if (bpm < PhysiologyTuning.PULSE_MIN_BPM || bpm > PhysiologyTuning.PULSE_MAX_BPM) {
            return PulseResult.Rejected(
                PulseRejectionReason.OUT_OF_RANGE, durationMs, sampleCount, quality,
            )
        }

        val confidence = SignalCore.confidence(
            periodicity = result.periodicity,
            stability = stability,
            durationMs = durationMs,
            fullDurationMs = PhysiologyTuning.PULSE_CONFIDENCE_FULL_DURATION_MS,
        )

        return PulseResult.Measured(
            bpm = bpm,
            durationMs = durationMs,
            sampleCount = sampleCount,
            effectiveSampleRateHz = SignalCore.effectiveSampleRateHz(sampleCount, durationMs),
            quality = quality,
            confidence = confidence,
            confidenceBand = SignalCore.confidenceBand(confidence),
            measuredAtMs = measuredAtMs,
        )
    }

    /** A longer session is not an error; the most recent window is used. */
    private fun trimToWindow(samples: List<PulseSample>): List<PulseSample> {
        if (samples.size < 2) return samples
        val cutoff =
            samples[samples.size - 1].timestampMs - PhysiologyTuning.PULSE_MAX_DURATION_MS
        return samples.filter { it.timestampMs >= cutoff }
    }

    /**
     * With the torch lit and a fingertip covering the lens, transmitted light is
     * strongly red-dominant; an uncovered lens sees far more balanced channels.
     */
    private fun coverageOf(samples: List<PulseSample>): Double {
        if (samples.isEmpty()) return 0.0
        var passing = 0
        for (sample in samples) {
            if (sample.red >= PhysiologyTuning.FINGER_MIN_RED &&
                sample.green <= PhysiologyTuning.FINGER_MAX_GREEN &&
                sample.red - sample.green >= PhysiologyTuning.FINGER_MIN_RED_EXCESS
            ) {
                passing += 1
            }
        }
        return passing.toDouble() / samples.size
    }
}

/** Breathing — Kotlin implementation of `engines/breathing-estimation-spec/SPEC.md`. */
object BreathingEstimator {
    private val minLag =
        ((60 * PhysiologyTuning.RESAMPLE_HZ) / PhysiologyTuning.BREATHING_MAX_PER_MINUTE)
            .roundToInt()
    private val maxLag =
        ((60 * PhysiologyTuning.RESAMPLE_HZ) / PhysiologyTuning.BREATHING_MIN_PER_MINUTE)
            .roundToInt()

    /**
     * The phase at a point in a guided session. The same schedule is produced
     * everywhere, which is what lets two partners breathe together without either
     * device being authoritative.
     */
    fun phaseAt(pattern: BreathingPattern, elapsedMs: Double): BreathingPhaseState {
        val cycleMs =
            pattern.inhaleMs + pattern.holdMs + pattern.exhaleMs + pattern.holdAfterMs
        val totalMs = cycleMs * pattern.cycles
        if (cycleMs <= 0 || pattern.cycles <= 0 || elapsedMs >= totalMs) {
            return BreathingPhaseState(
                phase = BreathingPhase.COMPLETE,
                cycleIndex = max(0, pattern.cycles - 1),
                progress = 1.0,
                remainingMs = 0.0,
            )
        }

        val clampedElapsed = max(0.0, elapsedMs)
        val cycleIndex = (clampedElapsed / cycleMs).toInt()
        var offset = clampedElapsed - cycleIndex * cycleMs

        val segments = listOf(
            BreathingPhase.INHALE to pattern.inhaleMs,
            BreathingPhase.HOLD to pattern.holdMs,
            BreathingPhase.EXHALE to pattern.exhaleMs,
            BreathingPhase.HOLD_AFTER to pattern.holdAfterMs,
        )
        for ((phase, duration) in segments) {
            if (duration <= 0) continue
            if (offset < duration) {
                return BreathingPhaseState(
                    phase = phase,
                    cycleIndex = cycleIndex,
                    progress = offset / duration,
                    remainingMs = duration - offset,
                )
            }
            offset -= duration
        }

        // Unreachable while the segments sum to the cycle length; returning the
        // last real phase keeps a rounding edge from stopping a session.
        return BreathingPhaseState(BreathingPhase.HOLD_AFTER, cycleIndex, 1.0, 0.0)
    }

    fun estimate(samples: List<BreathingSample>, measuredAtMs: Double): BreathingResult {
        val ordered = SignalCore.monotonic(samples) { it.timestampMs }
        val sampleCount = ordered.size
        val durationMs = if (sampleCount < 2) {
            0.0
        } else {
            ordered[sampleCount - 1].timestampMs - ordered[0].timestampMs
        }

        if (sampleCount < 2 || durationMs < PhysiologyTuning.BREATHING_MIN_DURATION_MS) {
            return BreathingResult.Rejected(
                BreathingRejectionReason.TOO_SHORT, durationMs, sampleCount,
                SignalQuality.EMPTY,
            )
        }

        var tracked = 0
        for (sample in ordered) if (sample.tracked) tracked += 1
        val coverage = tracked.toDouble() / sampleCount

        val resampled = SignalCore.resample(
            ordered.map { SignalCore.TimedSample(it.timestampMs, it.chestOffset) },
        )
        val baseline = SignalCore.movingAverage(
            resampled, PhysiologyTuning.BREATHING_DETREND_WINDOW_SAMPLES,
        )
        val detrended = DoubleArray(resampled.size) { resampled[it] - baseline[it] }
        val filtered = SignalCore.movingAverage(
            detrended, PhysiologyTuning.BREATHING_SMOOTH_WINDOW_SAMPLES,
        )

        val result = SignalCore.periodicity(filtered, minLag, maxLag)
        val motion = SignalCore.motion(resampled, PhysiologyTuning.BREATHING_MOTION_SCALE)
        val stability = SignalCore.stability(
            filtered,
            SignalCore.StabilityOptions(
                windowSamples = PhysiologyTuning.BREATHING_STABILITY_WINDOW_SAMPLES,
                stepSamples = PhysiologyTuning.BREATHING_STABILITY_STEP_SAMPLES,
                scale = PhysiologyTuning.BREATHING_STABILITY_SCALE,
                minLag = minLag,
                maxLag = maxLag,
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

        if (coverage < PhysiologyTuning.BREATHING_MIN_COVERAGE) {
            return BreathingResult.Rejected(
                BreathingRejectionReason.NOT_TRACKED, durationMs, sampleCount, quality,
            )
        }
        if (motion > PhysiologyTuning.BREATHING_MAX_MOTION) {
            return BreathingResult.Rejected(
                BreathingRejectionReason.EXCESSIVE_MOTION, durationMs, sampleCount, quality,
            )
        }
        val refinedLag = result.refinedLag
        if (result.periodicity < PhysiologyTuning.BREATHING_MIN_PERIODICITY ||
            refinedLag == null
        ) {
            return BreathingResult.Rejected(
                BreathingRejectionReason.NO_PERIODICITY, durationMs, sampleCount, quality,
            )
        }
        if (stability < PhysiologyTuning.BREATHING_MIN_STABILITY) {
            return BreathingResult.Rejected(
                BreathingRejectionReason.UNSTABLE, durationMs, sampleCount, quality,
            )
        }

        val rate = SignalCore.roundToTenth(SignalCore.ratePerMinuteFromLag(refinedLag))
        if (rate < PhysiologyTuning.BREATHING_MIN_PER_MINUTE ||
            rate > PhysiologyTuning.BREATHING_MAX_PER_MINUTE
        ) {
            return BreathingResult.Rejected(
                BreathingRejectionReason.OUT_OF_RANGE, durationMs, sampleCount, quality,
            )
        }

        val confidence = SignalCore.confidence(
            periodicity = result.periodicity,
            stability = stability,
            durationMs = durationMs,
            fullDurationMs = PhysiologyTuning.BREATHING_CONFIDENCE_FULL_DURATION_MS,
        )

        return BreathingResult.Measured(
            breathsPerMinute = rate,
            durationMs = durationMs,
            sampleCount = sampleCount,
            effectiveSampleRateHz = SignalCore.effectiveSampleRateHz(sampleCount, durationMs),
            quality = quality,
            confidence = confidence,
            confidenceBand = SignalCore.confidenceBand(confidence),
            measuredAtMs = measuredAtMs,
        )
    }
}

/**
 * Estimated energy expenditure — Kotlin implementation of
 * `engines/calorie-estimation-spec/SPEC.md`.
 */
object CalorieEstimator {
    private val baseMet = mapOf(
        CalorieActivity.REST to PhysiologyTuning.MET_REST,
        CalorieActivity.GUIDED_BREATHING to PhysiologyTuning.MET_GUIDED_BREATHING,
        CalorieActivity.SQUAT to PhysiologyTuning.MET_SQUAT,
        CalorieActivity.BODYWEIGHT_MIXED to PhysiologyTuning.MET_BODYWEIGHT_MIXED,
        CalorieActivity.WALKING_IN_PLACE to PhysiologyTuning.MET_WALKING_IN_PLACE,
    )

    private val repetitionActivities =
        setOf(CalorieActivity.SQUAT, CalorieActivity.BODYWEIGHT_MIXED)

    fun estimate(input: CalorieEstimateInput): CalorieEstimate {
        val durationMs = max(0.0, input.durationMs)
        val repetitions = max(0, input.repetitions ?: 0)
        val providedMass = input.bodyMassKg?.takeIf { it > 0 }
        val bodyMassKg = providedMass ?: PhysiologyTuning.DEFAULT_BODY_MASS_KG

        val inputsUsed = mutableListOf(CalorieInput.DURATION)
        if (input.repetitions != null) inputsUsed.add(CalorieInput.REPETITIONS)
        if (providedMass != null) inputsUsed.add(CalorieInput.BODY_MASS)
        if (input.poseConfidence != null) inputsUsed.add(CalorieInput.POSE_CONFIDENCE)

        val durationMinutes = durationMs / 60_000
        val base = baseMet[input.activity] ?: PhysiologyTuning.MET_REST
        val met = if (input.activity in repetitionActivities && durationMinutes > 0) {
            base * intensityFactor(repetitions / durationMinutes)
        } else {
            base
        }

        val estimatedKcal =
            if (durationMs < 1000) 0.0 else met * bodyMassKg * (durationMs / 3_600_000)

        var uncertainty = PhysiologyTuning.CALORIE_BASE_UNCERTAINTY
        if (providedMass == null) uncertainty += PhysiologyTuning.CALORIE_NO_BODY_MASS_PENALTY
        if (durationMs < PhysiologyTuning.CALORIE_SHORT_SESSION_MS) {
            uncertainty += PhysiologyTuning.CALORIE_SHORT_SESSION_PENALTY
        }
        val poseConfidence = input.poseConfidence
        if (poseConfidence != null &&
            poseConfidence < PhysiologyTuning.CALORIE_LOW_POSE_CONFIDENCE
        ) {
            uncertainty += PhysiologyTuning.CALORIE_LOW_CONFIDENCE_PENALTY
        }
        uncertainty = min(PhysiologyTuning.CALORIE_MAX_UNCERTAINTY, uncertainty)

        val rounded = SignalCore.roundToTenth(estimatedKcal)
        return CalorieEstimate(
            estimatedKcal = rounded,
            algorithmVersion = PhysiologyTuning.CALORIE_ALGORITHM_VERSION,
            activity = input.activity,
            durationMs = durationMs,
            repetitions = repetitions,
            met = met,
            bodyMassKg = bodyMassKg,
            inputsUsed = inputsUsed,
            lowKcal = SignalCore.roundToTenth(rounded * (1 - uncertainty)),
            highKcal = SignalCore.roundToTenth(rounded * (1 + uncertainty)),
            // A zero-length session gets the widest band rather than a
            // rejection: zero is the honest answer.
            bandLabel = if (durationMs < 1000) {
                CalorieBandLabel.VERY_WIDE
            } else {
                bandLabel(uncertainty)
            },
        )
    }

    /**
     * Twenty repetitions per minute is full intensity. The clamp keeps a burst of
     * fast repetitions in a very short session from producing an absurd
     * multiplier, because duration is in the denominator.
     */
    private fun intensityFactor(repsPerMinute: Double): Double = SignalCore.clamp(
        0.7 + 0.6 * SignalCore.clamp(
            repsPerMinute / PhysiologyTuning.CALORIE_FULL_INTENSITY_REPS_PER_MINUTE, 0.0, 1.0,
        ),
        0.7,
        1.3,
    )

    private fun bandLabel(uncertainty: Double): CalorieBandLabel = when {
        uncertainty <= 0.3 -> CalorieBandLabel.MODERATE
        uncertainty <= 0.5 -> CalorieBandLabel.WIDE
        else -> CalorieBandLabel.VERY_WIDE
    }
}

/**
 * Freshness is a property of the reading, not of the screen. Master
 * specification §4 forbids animating an old rate as if it were current.
 */
object PulseFreshness {
    fun ageMs(pulse: PulseResult.Measured, nowMs: Double): Double =
        max(0.0, nowMs - pulse.measuredAtMs)

    fun isFresh(pulse: PulseResult.Measured, nowMs: Double): Boolean =
        ageMs(pulse, nowMs) < PhysiologyTuning.PULSE_FRESHNESS_MS
}

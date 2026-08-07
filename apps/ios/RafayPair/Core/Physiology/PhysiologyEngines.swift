import Foundation

/// Finger-camera pulse estimation — Swift implementation of
/// `engines/pulse-estimation-spec/SPEC.md`.
///
/// Produces a real number from a real signal, and refuses to produce one
/// otherwise. No blood-pressure value is derived here or anywhere else.
enum PulseEstimator {
    private static let minLag = Int(
        ((60 * PhysiologyTuning.resampleHz) / PhysiologyTuning.pulseMaxBpm).rounded()
    )
    private static let maxLag = Int(
        ((60 * PhysiologyTuning.resampleHz) / PhysiologyTuning.pulseMinBpm).rounded()
    )

    static func estimate(_ samples: [PulseSample], measuredAtMs: Double) -> PulseResult {
        let ordered = trimToWindow(SignalCore.monotonic(samples) { $0.timestampMs })
        let sampleCount = ordered.count
        let durationMs =
            sampleCount < 2
            ? 0 : ordered[sampleCount - 1].timestampMs - ordered[0].timestampMs

        if sampleCount < 2 || durationMs < PhysiologyTuning.pulseMinDurationMs {
            return .rejected(
                reason: .tooShort,
                durationMs: durationMs,
                sampleCount: sampleCount,
                quality: .empty
            )
        }

        let coverage = coverageOf(ordered)
        let resampled = SignalCore.resample(
            ordered.map {
                SignalCore.TimedSample(timestampMs: $0.timestampMs, value: $0.red)
            }
        )
        let baseline = SignalCore.movingAverage(
            resampled, window: PhysiologyTuning.pulseDetrendWindowSamples
        )
        var detrended: [Double] = []
        detrended.reserveCapacity(resampled.count)
        for index in resampled.indices { detrended.append(resampled[index] - baseline[index]) }
        let filtered = SignalCore.movingAverage(
            detrended, window: PhysiologyTuning.pulseSmoothWindowSamples
        )

        let result = SignalCore.periodicity(filtered, minLag: minLag, maxLag: maxLag)
        let motion = SignalCore.motion(resampled, scale: PhysiologyTuning.pulseMotionScale)
        let stability = SignalCore.stability(
            filtered,
            options: SignalCore.StabilityOptions(
                windowSamples: PhysiologyTuning.pulseStabilityWindowSamples,
                stepSamples: PhysiologyTuning.pulseStabilityStepSamples,
                scale: PhysiologyTuning.pulseStabilityScale,
                minLag: minLag,
                maxLag: maxLag
            )
        )
        let amplitude = SignalCore.amplitude(filtered, resampled)

        let score =
            0.35 * result.periodicity + 0.25 * coverage + 0.2 * stability + 0.2 * (1 - motion)
        let quality = SignalQuality(
            score: score,
            band: SignalCore.qualityBand(score),
            coverage: coverage,
            motion: motion,
            periodicity: result.periodicity,
            amplitude: amplitude,
            stability: stability
        )

        // Ordering is normative: the reason is shown to the user and must name
        // the first thing they can act on.
        if coverage < PhysiologyTuning.pulseMinCoverage {
            return .rejected(
                reason: .fingerNotDetected, durationMs: durationMs,
                sampleCount: sampleCount, quality: quality
            )
        }
        if motion > PhysiologyTuning.pulseMaxMotion {
            return .rejected(
                reason: .excessiveMotion, durationMs: durationMs,
                sampleCount: sampleCount, quality: quality
            )
        }
        guard result.periodicity >= PhysiologyTuning.pulseMinPeriodicity,
            let refinedLag = result.refinedLag
        else {
            return .rejected(
                reason: .noPeriodicity, durationMs: durationMs,
                sampleCount: sampleCount, quality: quality
            )
        }
        // A strong but drifting peak is not a pulse.
        if stability < PhysiologyTuning.pulseMinStability {
            return .rejected(
                reason: .unstable, durationMs: durationMs,
                sampleCount: sampleCount, quality: quality
            )
        }

        let bpm = SignalCore.roundToTenth(SignalCore.ratePerMinute(fromLag: refinedLag))
        if bpm < PhysiologyTuning.pulseMinBpm || bpm > PhysiologyTuning.pulseMaxBpm {
            return .rejected(
                reason: .outOfRange, durationMs: durationMs,
                sampleCount: sampleCount, quality: quality
            )
        }

        let confidence = SignalCore.confidence(
            periodicity: result.periodicity,
            stability: stability,
            durationMs: durationMs,
            fullDurationMs: PhysiologyTuning.pulseConfidenceFullDurationMs
        )

        return .measured(
            MeasuredPulse(
                bpm: bpm,
                durationMs: durationMs,
                sampleCount: sampleCount,
                effectiveSampleRateHz: SignalCore.effectiveSampleRateHz(
                    sampleCount: sampleCount, durationMs: durationMs
                ),
                quality: quality,
                confidence: confidence,
                confidenceBand: SignalCore.confidenceBand(confidence),
                measuredAtMs: measuredAtMs
            )
        )
    }

    /// A longer session is not an error; the most recent window is used.
    private static func trimToWindow(_ samples: [PulseSample]) -> [PulseSample] {
        guard samples.count >= 2 else { return samples }
        let cutoff = samples[samples.count - 1].timestampMs - PhysiologyTuning.pulseMaxDurationMs
        return samples.filter { $0.timestampMs >= cutoff }
    }

    /// With the torch lit and a fingertip covering the lens, transmitted light
    /// is strongly red-dominant; an uncovered lens sees far more balanced
    /// channels.
    private static func coverageOf(_ samples: [PulseSample]) -> Double {
        guard !samples.isEmpty else { return 0 }
        var passing = 0
        for sample in samples
        where sample.red >= PhysiologyTuning.fingerMinRed
            && sample.green <= PhysiologyTuning.fingerMaxGreen
            && sample.red - sample.green >= PhysiologyTuning.fingerMinRedExcess
        {
            passing += 1
        }
        return Double(passing) / Double(samples.count)
    }
}

/// Breathing — Swift implementation of
/// `engines/breathing-estimation-spec/SPEC.md`.
enum BreathingEstimator {
    private static let minLag = Int(
        ((60 * PhysiologyTuning.resampleHz) / PhysiologyTuning.breathingMaxPerMinute).rounded()
    )
    private static let maxLag = Int(
        ((60 * PhysiologyTuning.resampleHz) / PhysiologyTuning.breathingMinPerMinute).rounded()
    )

    /// The phase at a point in a guided session. The same schedule is produced
    /// everywhere, which is what lets two partners breathe together without
    /// either device being authoritative.
    static func phase(of pattern: BreathingPattern, elapsedMs: Double) -> BreathingPhaseState {
        let cycleMs =
            pattern.inhaleMs + pattern.holdMs + pattern.exhaleMs + pattern.holdAfterMs
        let totalMs = cycleMs * Double(pattern.cycles)
        if cycleMs <= 0 || pattern.cycles <= 0 || elapsedMs >= totalMs {
            return BreathingPhaseState(
                phase: .complete,
                cycleIndex: max(0, pattern.cycles - 1),
                progress: 1,
                remainingMs: 0
            )
        }

        let clampedElapsed = max(0, elapsedMs)
        let cycleIndex = Int((clampedElapsed / cycleMs).rounded(.down))
        var offset = clampedElapsed - Double(cycleIndex) * cycleMs

        let segments: [(BreathingPhase, Double)] = [
            (.inhale, pattern.inhaleMs),
            (.hold, pattern.holdMs),
            (.exhale, pattern.exhaleMs),
            (.holdAfter, pattern.holdAfterMs),
        ]
        for (phase, duration) in segments {
            if duration <= 0 { continue }
            if offset < duration {
                return BreathingPhaseState(
                    phase: phase,
                    cycleIndex: cycleIndex,
                    progress: offset / duration,
                    remainingMs: duration - offset
                )
            }
            offset -= duration
        }

        // Unreachable while the segments sum to the cycle length; returning the
        // last real phase keeps a rounding edge from stopping a session.
        return BreathingPhaseState(
            phase: .holdAfter, cycleIndex: cycleIndex, progress: 1, remainingMs: 0
        )
    }

    static func estimate(
        _ samples: [BreathingSample],
        measuredAtMs: Double
    ) -> BreathingResult {
        let ordered = SignalCore.monotonic(samples) { $0.timestampMs }
        let sampleCount = ordered.count
        let durationMs =
            sampleCount < 2
            ? 0 : ordered[sampleCount - 1].timestampMs - ordered[0].timestampMs

        if sampleCount < 2 || durationMs < PhysiologyTuning.breathingMinDurationMs {
            return .rejected(
                reason: .tooShort, durationMs: durationMs,
                sampleCount: sampleCount, quality: .empty
            )
        }

        var tracked = 0
        for sample in ordered where sample.tracked { tracked += 1 }
        let coverage = Double(tracked) / Double(sampleCount)

        let resampled = SignalCore.resample(
            ordered.map {
                SignalCore.TimedSample(timestampMs: $0.timestampMs, value: $0.chestOffset)
            }
        )
        let baseline = SignalCore.movingAverage(
            resampled, window: PhysiologyTuning.breathingDetrendWindowSamples
        )
        var detrended: [Double] = []
        detrended.reserveCapacity(resampled.count)
        for index in resampled.indices { detrended.append(resampled[index] - baseline[index]) }
        let filtered = SignalCore.movingAverage(
            detrended, window: PhysiologyTuning.breathingSmoothWindowSamples
        )

        let result = SignalCore.periodicity(filtered, minLag: minLag, maxLag: maxLag)
        let motion = SignalCore.motion(
            resampled, scale: PhysiologyTuning.breathingMotionScale
        )
        let stability = SignalCore.stability(
            filtered,
            options: SignalCore.StabilityOptions(
                windowSamples: PhysiologyTuning.breathingStabilityWindowSamples,
                stepSamples: PhysiologyTuning.breathingStabilityStepSamples,
                scale: PhysiologyTuning.breathingStabilityScale,
                minLag: minLag,
                maxLag: maxLag
            )
        )
        let amplitude = SignalCore.amplitude(filtered, resampled)

        let score =
            0.4 * result.periodicity + 0.25 * coverage + 0.2 * stability + 0.15 * (1 - motion)
        let quality = SignalQuality(
            score: score,
            band: SignalCore.qualityBand(score),
            coverage: coverage,
            motion: motion,
            periodicity: result.periodicity,
            amplitude: amplitude,
            stability: stability
        )

        if coverage < PhysiologyTuning.breathingMinCoverage {
            return .rejected(
                reason: .notTracked, durationMs: durationMs,
                sampleCount: sampleCount, quality: quality
            )
        }
        if motion > PhysiologyTuning.breathingMaxMotion {
            return .rejected(
                reason: .excessiveMotion, durationMs: durationMs,
                sampleCount: sampleCount, quality: quality
            )
        }
        guard result.periodicity >= PhysiologyTuning.breathingMinPeriodicity,
            let refinedLag = result.refinedLag
        else {
            return .rejected(
                reason: .noPeriodicity, durationMs: durationMs,
                sampleCount: sampleCount, quality: quality
            )
        }
        if stability < PhysiologyTuning.breathingMinStability {
            return .rejected(
                reason: .unstable, durationMs: durationMs,
                sampleCount: sampleCount, quality: quality
            )
        }

        let rate = SignalCore.roundToTenth(SignalCore.ratePerMinute(fromLag: refinedLag))
        if rate < PhysiologyTuning.breathingMinPerMinute
            || rate > PhysiologyTuning.breathingMaxPerMinute
        {
            return .rejected(
                reason: .outOfRange, durationMs: durationMs,
                sampleCount: sampleCount, quality: quality
            )
        }

        let confidence = SignalCore.confidence(
            periodicity: result.periodicity,
            stability: stability,
            durationMs: durationMs,
            fullDurationMs: PhysiologyTuning.breathingConfidenceFullDurationMs
        )

        return .measured(
            MeasuredBreathing(
                breathsPerMinute: rate,
                durationMs: durationMs,
                sampleCount: sampleCount,
                effectiveSampleRateHz: SignalCore.effectiveSampleRateHz(
                    sampleCount: sampleCount, durationMs: durationMs
                ),
                quality: quality,
                confidence: confidence,
                confidenceBand: SignalCore.confidenceBand(confidence),
                measuredAtMs: measuredAtMs
            )
        )
    }
}

/// Estimated energy expenditure — Swift implementation of
/// `engines/calorie-estimation-spec/SPEC.md`.
enum CalorieEstimator {
    private static let baseMet: [CalorieActivity: Double] = [
        .rest: PhysiologyTuning.metRest,
        .guidedBreathing: PhysiologyTuning.metGuidedBreathing,
        .squat: PhysiologyTuning.metSquat,
        .bodyweightMixed: PhysiologyTuning.metBodyweightMixed,
        .walkingInPlace: PhysiologyTuning.metWalkingInPlace,
    ]

    private static let repetitionActivities: Set<CalorieActivity> = [
        .squat, .bodyweightMixed,
    ]

    static func estimate(_ input: CalorieEstimateInput) -> CalorieEstimate {
        let durationMs = max(0, input.durationMs)
        let repetitions = max(0, input.repetitions ?? 0)
        let providedMass = (input.bodyMassKg ?? 0) > 0 ? input.bodyMassKg : nil
        let bodyMassKg = providedMass ?? PhysiologyTuning.defaultBodyMassKg

        var inputsUsed: [CalorieInput] = [.duration]
        if input.repetitions != nil { inputsUsed.append(.repetitions) }
        if providedMass != nil { inputsUsed.append(.bodyMass) }
        if input.poseConfidence != nil { inputsUsed.append(.poseConfidence) }

        let durationMinutes = durationMs / 60_000
        let base = baseMet[input.activity] ?? PhysiologyTuning.metRest
        let met =
            repetitionActivities.contains(input.activity) && durationMinutes > 0
            ? base * intensityFactor(Double(repetitions) / durationMinutes)
            : base

        let estimatedKcal =
            durationMs < 1000 ? 0 : met * bodyMassKg * (durationMs / 3_600_000)

        var uncertainty = PhysiologyTuning.calorieBaseUncertainty
        if providedMass == nil { uncertainty += PhysiologyTuning.calorieNoBodyMassPenalty }
        if durationMs < PhysiologyTuning.calorieShortSessionMs {
            uncertainty += PhysiologyTuning.calorieShortSessionPenalty
        }
        if let poseConfidence = input.poseConfidence,
            poseConfidence < PhysiologyTuning.calorieLowPoseConfidence
        {
            uncertainty += PhysiologyTuning.calorieLowConfidencePenalty
        }
        uncertainty = min(PhysiologyTuning.calorieMaxUncertainty, uncertainty)

        let rounded = SignalCore.roundToTenth(estimatedKcal)
        return CalorieEstimate(
            estimatedKcal: rounded,
            algorithmVersion: PhysiologyTuning.calorieAlgorithmVersion,
            activity: input.activity,
            durationMs: durationMs,
            repetitions: repetitions,
            met: met,
            bodyMassKg: bodyMassKg,
            inputsUsed: inputsUsed,
            lowKcal: SignalCore.roundToTenth(rounded * (1 - uncertainty)),
            highKcal: SignalCore.roundToTenth(rounded * (1 + uncertainty)),
            // A zero-length session gets the widest band rather than a
            // rejection: zero is the honest answer.
            bandLabel: durationMs < 1000 ? .veryWide : bandLabel(uncertainty)
        )
    }

    /// Twenty repetitions per minute is full intensity. The clamp keeps a burst
    /// of fast repetitions in a very short session from producing an absurd
    /// multiplier, because duration is in the denominator.
    private static func intensityFactor(_ repsPerMinute: Double) -> Double {
        SignalCore.clamp(
            0.7
                + 0.6
                * SignalCore.clamp(
                    repsPerMinute / PhysiologyTuning.calorieFullIntensityRepsPerMinute, 0, 1
                ),
            0.7,
            1.3
        )
    }

    private static func bandLabel(_ uncertainty: Double) -> CalorieBandLabel {
        if uncertainty <= 0.3 { return .moderate }
        if uncertainty <= 0.5 { return .wide }
        return .veryWide
    }
}

/// Freshness is a property of the reading, not of the screen. Master
/// specification §4 forbids animating an old rate as if it were current.
enum PulseFreshness {
    static func ageMs(_ pulse: MeasuredPulse, now: Double) -> Double {
        max(0, now - pulse.measuredAtMs)
    }

    static func isFresh(_ pulse: MeasuredPulse, now: Double) -> Bool {
        ageMs(pulse, now: now) < PhysiologyTuning.pulseFreshnessMs
    }
}

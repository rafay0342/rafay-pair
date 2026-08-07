import Foundation

/// Microphone breathing rhythm — Swift implementation of
/// `engines/breathing-estimation-spec/MICROPHONE.md` (master specification §6C).
///
/// Raw audio never reaches the estimator. Its input carries only per-hop
/// features — a band energy, a zero-crossing rate, and a peak level — from which
/// speech is not reconstructible. That is the retention rule made structural
/// rather than promised.
enum AudioBreathingEstimator {
    private static let minLag = Int(
        ((60 * PhysiologyTuning.resampleHz) / PhysiologyTuning.breathingMaxPerMinute).rounded()
    )
    private static let maxLag = Int(
        ((60 * PhysiologyTuning.resampleHz) / PhysiologyTuning.breathingMinPerMinute).rounded()
    )

    /// Converts a block of microphone samples into per-hop features.
    ///
    /// This is the only function that ever sees audio, and it returns numbers
    /// rather than a signal. The band-pass is a cascade of two one-pole filters,
    /// chosen because a one-pole recurrence is exactly reproducible in three
    /// languages with no filter-design library and no coefficient tables.
    ///
    /// - Parameter samples: floating point in `-1...1`
    static func extractHops(
        _ samples: [Double],
        startTimestampMs: Double
    ) -> [AudioHopFeature] {
        let highPassAlpha =
            1
            / (1 + (2 * Double.pi * PhysiologyTuning.audioHighPassHz)
                / PhysiologyTuning.audioSampleRateHz)
        let lowPassOmega =
            (2 * Double.pi * PhysiologyTuning.audioLowPassHz)
            / PhysiologyTuning.audioSampleRateHz
        let lowPassAlpha = lowPassOmega / (1 + lowPassOmega)

        var hops: [AudioHopFeature] = []
        var previousRaw = 0.0
        var previousHighPassed = 0.0
        var banded = 0.0

        // A trailing partial hop is discarded rather than padded: padding would
        // invent a quieter hop and drag the envelope down exactly when a session
        // ends.
        let hopSamples = PhysiologyTuning.audioHopSamples
        let hopCount = samples.count / hopSamples
        var cursor = 0

        for hop in 0..<hopCount {
            var energy = 0.0
            var crossings = 0
            var peak = 0.0
            var previousBanded = banded

            for index in 0..<hopSamples {
                let raw = samples[cursor]
                cursor += 1

                let highPassed = highPassAlpha * (previousHighPassed + raw - previousRaw)
                banded += lowPassAlpha * (highPassed - banded)
                previousRaw = raw
                previousHighPassed = highPassed

                energy += banded * banded
                let magnitude = abs(raw)
                if magnitude > peak { peak = magnitude }
                if index > 0, signOf(previousBanded) * signOf(banded) < 0 {
                    crossings += 1
                }
                previousBanded = banded
            }

            hops.append(
                AudioHopFeature(
                    timestampMs: startTimestampMs
                        + (Double(hop) * Double(hopSamples) * 1000)
                            / PhysiologyTuning.audioSampleRateHz,
                    rms: (energy / Double(hopSamples)).squareRoot(),
                    zeroCrossingRate: Double(crossings) / Double(hopSamples - 1),
                    peak: peak
                )
            )
        }
        return hops
    }

    private static func signOf(_ value: Double) -> Double {
        if value > 0 { return 1 }
        if value < 0 { return -1 }
        return 0
    }

    /// A hop is usable when it is audible, unclipped, and its zero-crossing rate
    /// looks like broadband turbulence rather than voiced speech (too periodic)
    /// or hiss (too dense).
    static func isHopUsable(_ hop: AudioHopFeature) -> Bool {
        hop.rms >= PhysiologyTuning.audioRmsFloor
            && hop.peak < PhysiologyTuning.audioPeakClip
            && hop.zeroCrossingRate >= PhysiologyTuning.audioZcrMin
            && hop.zeroCrossingRate <= PhysiologyTuning.audioZcrMax
    }

    static func estimate(
        _ hops: [AudioHopFeature],
        measuredAtMs: Double
    ) -> AudioBreathingResult {
        let ordered = SignalCore.monotonic(hops) { $0.timestampMs }
        let hopCount = ordered.count
        let durationMs =
            hopCount < 2
            ? 0 : ordered[hopCount - 1].timestampMs - ordered[0].timestampMs

        if hopCount < 2 || durationMs < PhysiologyTuning.micMinDurationMs {
            return .rejected(
                reason: .tooShort, durationMs: durationMs,
                hopCount: hopCount, quality: .empty
            )
        }

        var usable = 0
        for hop in ordered where isHopUsable(hop) { usable += 1 }
        let coverage = Double(usable) / Double(hopCount)

        // Unusable hops still contribute their energy: removing them would punch
        // holes in the envelope that the autocorrelation would read as rhythm.
        let resampled = SignalCore.resample(
            ordered.map { SignalCore.TimedSample(timestampMs: $0.timestampMs, value: $0.rms) }
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

        let result = SignalCore.periodicity(
            filtered, minLag: minLag, maxLag: maxLag, fold: .energyPerHalfCycle
        )
        let motion = SignalCore.motion(resampled, scale: PhysiologyTuning.micMotionScale)
        let stability = SignalCore.stability(
            filtered,
            options: SignalCore.StabilityOptions(
                windowSamples: PhysiologyTuning.breathingStabilityWindowSamples,
                stepSamples: PhysiologyTuning.breathingStabilityStepSamples,
                scale: PhysiologyTuning.breathingStabilityScale,
                minLag: minLag,
                maxLag: maxLag,
                fold: .energyPerHalfCycle
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

        if coverage < PhysiologyTuning.micMinCoverage {
            return .rejected(
                reason: .notAudible, durationMs: durationMs,
                hopCount: hopCount, quality: quality
            )
        }
        if motion > PhysiologyTuning.micMaxMotion {
            return .rejected(
                reason: .tooNoisy, durationMs: durationMs,
                hopCount: hopCount, quality: quality
            )
        }
        guard result.periodicity >= PhysiologyTuning.micMinPeriodicity,
            let refinedLag = result.refinedLag
        else {
            return .rejected(
                reason: .noPeriodicity, durationMs: durationMs,
                hopCount: hopCount, quality: quality
            )
        }
        if stability < PhysiologyTuning.micMinStability {
            return .rejected(
                reason: .unstable, durationMs: durationMs,
                hopCount: hopCount, quality: quality
            )
        }

        let rate = SignalCore.roundToTenth(SignalCore.ratePerMinute(fromLag: refinedLag))
        if rate < PhysiologyTuning.breathingMinPerMinute
            || rate > PhysiologyTuning.breathingMaxPerMinute
        {
            return .rejected(
                reason: .outOfRange, durationMs: durationMs,
                hopCount: hopCount, quality: quality
            )
        }

        let confidence = SignalCore.confidence(
            periodicity: result.periodicity,
            stability: stability,
            durationMs: durationMs,
            fullDurationMs: PhysiologyTuning.micConfidenceFullDurationMs
        )

        return .measured(
            MeasuredAudioBreathing(
                breathsPerMinute: rate,
                durationMs: durationMs,
                hopCount: hopCount,
                effectiveSampleRateHz: SignalCore.effectiveSampleRateHz(
                    sampleCount: hopCount, durationMs: durationMs
                ),
                quality: quality,
                confidence: confidence,
                confidenceBand: SignalCore.confidenceBand(confidence),
                measuredAtMs: measuredAtMs
            )
        )
    }
}

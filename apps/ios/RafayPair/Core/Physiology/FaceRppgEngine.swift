import Foundation

/// Face-camera pulse, research mode — Swift implementation of
/// `engines/pulse-estimation-spec/FACE_RPPG.md` (master specification §3.3).
///
/// Experimental by construction. Specification §6 forbids this result from
/// feeding the heart visualization, the consent-gated share, or the stored
/// latest pulse. Nothing outside this file and its own surface references it,
/// which is what makes the mode removable without breaking the application.
enum FaceRppgEstimator {
    private static let minLag = Int(
        ((60 * PhysiologyTuning.resampleHz) / PhysiologyTuning.faceMaxBpm).rounded()
    )
    private static let maxLag = Int(
        ((60 * PhysiologyTuning.resampleHz) / PhysiologyTuning.faceMinBpm).rounded()
    )

    static func estimate(
        _ samples: [FaceRppgSample],
        measuredAtMs: Double
    ) -> FaceRppgResult {
        let ordered = trimToWindow(SignalCore.monotonic(samples) { $0.timestampMs })
        let sampleCount = ordered.count
        let durationMs =
            sampleCount < 2
            ? 0 : ordered[sampleCount - 1].timestampMs - ordered[0].timestampMs

        if sampleCount < 2 || durationMs < PhysiologyTuning.faceMinDurationMs {
            return .rejected(
                reason: .tooShort, durationMs: durationMs,
                sampleCount: sampleCount, quality: .empty, lumaSwing: 0
            )
        }

        let coverage = coverageOf(ordered)
        let lumaSwing = lumaSwingOf(ordered)

        // Haemoglobin absorbs green most strongly, which is why the green
        // channel rather than the red one carries the pulsatile component
        // through skin.
        let resampled = SignalCore.resample(
            ordered.map {
                SignalCore.TimedSample(timestampMs: $0.timestampMs, value: $0.green)
            }
        )
        let baseline = SignalCore.movingAverage(
            resampled, window: PhysiologyTuning.faceDetrendWindowSamples
        )
        var detrended: [Double] = []
        detrended.reserveCapacity(resampled.count)
        for index in resampled.indices { detrended.append(resampled[index] - baseline[index]) }
        let filtered = SignalCore.movingAverage(
            detrended, window: PhysiologyTuning.faceSmoothWindowSamples
        )

        let result = SignalCore.periodicity(filtered, minLag: minLag, maxLag: maxLag)
        let motion = SignalCore.motion(resampled, scale: PhysiologyTuning.faceMotionScale)
        let stability = SignalCore.stability(
            filtered,
            options: SignalCore.StabilityOptions(
                windowSamples: PhysiologyTuning.faceStabilityWindowSamples,
                stepSamples: PhysiologyTuning.faceStabilityStepSamples,
                scale: PhysiologyTuning.faceStabilityScale,
                minLag: minLag,
                maxLag: maxLag
            )
        )
        let amplitude = SignalCore.amplitude(filtered, resampled)

        let score =
            0.4 * result.periodicity + 0.2 * coverage + 0.2 * stability + 0.2 * (1 - motion)
        let quality = SignalQuality(
            score: score,
            band: SignalCore.qualityBand(score),
            coverage: coverage,
            motion: motion,
            periodicity: result.periodicity,
            amplitude: amplitude,
            stability: stability
        )

        if coverage < PhysiologyTuning.faceMinCoverage {
            return .rejected(
                reason: .faceNotStable, durationMs: durationMs,
                sampleCount: sampleCount, quality: quality, lumaSwing: lumaSwing
            )
        }
        // Changing light produces exactly the slow brightness oscillation an
        // rPPG estimator mistakes for a pulse. The torch removes this problem on
        // the fingertip path; here it has to be caught.
        if lumaSwing > PhysiologyTuning.faceMaxLumaSwing {
            return .rejected(
                reason: .unstableLighting, durationMs: durationMs,
                sampleCount: sampleCount, quality: quality, lumaSwing: lumaSwing
            )
        }
        if motion > PhysiologyTuning.faceMaxMotion {
            return .rejected(
                reason: .excessiveMotion, durationMs: durationMs,
                sampleCount: sampleCount, quality: quality, lumaSwing: lumaSwing
            )
        }
        guard result.periodicity >= PhysiologyTuning.faceMinPeriodicity,
            let refinedLag = result.refinedLag
        else {
            return .rejected(
                reason: .noPeriodicity, durationMs: durationMs,
                sampleCount: sampleCount, quality: quality, lumaSwing: lumaSwing
            )
        }
        if stability < PhysiologyTuning.faceMinStability {
            return .rejected(
                reason: .unstable, durationMs: durationMs,
                sampleCount: sampleCount, quality: quality, lumaSwing: lumaSwing
            )
        }

        let bpm = SignalCore.roundToTenth(SignalCore.ratePerMinute(fromLag: refinedLag))
        if bpm < PhysiologyTuning.faceMinBpm || bpm > PhysiologyTuning.faceMaxBpm {
            return .rejected(
                reason: .outOfRange, durationMs: durationMs,
                sampleCount: sampleCount, quality: quality, lumaSwing: lumaSwing
            )
        }

        let confidence = SignalCore.confidence(
            periodicity: result.periodicity,
            stability: stability,
            durationMs: durationMs,
            fullDurationMs: PhysiologyTuning.faceConfidenceFullDurationMs
        )

        return .measured(
            MeasuredFaceRppg(
                bpm: bpm,
                durationMs: durationMs,
                sampleCount: sampleCount,
                effectiveSampleRateHz: SignalCore.effectiveSampleRateHz(
                    sampleCount: sampleCount, durationMs: durationMs
                ),
                quality: quality,
                lumaSwing: lumaSwing,
                confidence: confidence,
                confidenceBand: SignalCore.confidenceBand(confidence),
                measuredAtMs: measuredAtMs
            )
        )
    }

    private static func trimToWindow(_ samples: [FaceRppgSample]) -> [FaceRppgSample] {
        guard samples.count >= 2 else { return samples }
        let cutoff =
            samples[samples.count - 1].timestampMs - PhysiologyTuning.faceMaxDurationMs
        return samples.filter { $0.timestampMs >= cutoff }
    }

    /// A frame is usable when the face is present, lit within the sensor's
    /// usable range, and has not jumped since the previous usable frame.
    private static func coverageOf(_ samples: [FaceRppgSample]) -> Double {
        guard !samples.isEmpty else { return 0 }
        var usable = 0
        var previous: FaceRppgSample?
        for sample in samples {
            let lit =
                sample.luma >= PhysiologyTuning.faceMinLuma
                && sample.luma <= PhysiologyTuning.faceMaxLuma
            let present = sample.faceArea >= PhysiologyTuning.faceMinArea
            let still: Bool
            if let previous {
                still =
                    abs(sample.faceCenterX - previous.faceCenterX)
                    < PhysiologyTuning.faceMaxCenterShift
                    && abs(sample.faceCenterY - previous.faceCenterY)
                        < PhysiologyTuning.faceMaxCenterShift
            } else {
                still = true
            }
            if lit, present, still {
                usable += 1
                previous = sample
            }
        }
        return Double(usable) / Double(samples.count)
    }

    private static func lumaSwingOf(_ samples: [FaceRppgSample]) -> Double {
        var lowest = Double.infinity
        var highest = -Double.infinity
        var total = 0.0
        for sample in samples {
            if sample.luma < lowest { lowest = sample.luma }
            if sample.luma > highest { highest = sample.luma }
            total += sample.luma
        }
        let mean = total / Double(samples.count)
        return (highest - lowest) / max(mean, 1)
    }
}

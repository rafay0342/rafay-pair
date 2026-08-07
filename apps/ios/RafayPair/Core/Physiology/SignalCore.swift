import Foundation

/// The shared periodic-signal core — Swift implementation of
/// `engines/signal-quality/SPEC.md`.
///
/// Summation order is part of the contract: every loop accumulates in
/// increasing index order so that the TypeScript and Kotlin engines reproduce
/// the same rounding.
enum SignalCore {
    struct TimedSample {
        var timestampMs: Double
        var value: Double
    }

    struct Periodicity {
        /// Correlation at the chosen lag, floored at zero.
        var periodicity: Double
        /// Sub-sample refined lag, or `nil` when the band does not fit.
        var refinedLag: Double?
    }

    struct StabilityOptions {
        var windowSamples: Int
        var stepSamples: Int
        var scale: Double
        var minLag: Int
        var maxLag: Int
    }

    static func clamp(_ value: Double, _ low: Double, _ high: Double) -> Double {
        if value < low { return low }
        if value > high { return high }
        return value
    }

    /// Rounds to one decimal, half away from zero. Values here are never negative.
    static func roundToTenth(_ value: Double) -> Double {
        (value * 10).rounded() / 10
    }

    /// Drops samples whose timestamp does not advance, as the specification requires.
    static func monotonic<T>(
        _ samples: [T],
        timestamp: (T) -> Double
    ) -> [T] {
        var ordered: [T] = []
        for sample in samples {
            if let previous = ordered.last, timestamp(sample) <= timestamp(previous) {
                continue
            }
            ordered.append(sample)
        }
        return ordered
    }

    /// Linear resampling onto a uniform 30 Hz grid starting at the first
    /// timestamp. Camera delivery is irregular and every later stage assumes a
    /// fixed step, so the irregularity is resolved once, here.
    static func resample(_ samples: [TimedSample]) -> [Double] {
        guard samples.count >= 2 else { return samples.map(\.value) }

        let first = samples[0]
        let last = samples[samples.count - 1]
        let spanMs = last.timestampMs - first.timestampMs
        let count = Int((spanMs / PhysiologyTuning.resampleStepMs).rounded(.down)) + 1

        var values: [Double] = []
        values.reserveCapacity(count)
        var cursor = 0
        for index in 0..<count {
            let target =
                first.timestampMs + Double(index) * PhysiologyTuning.resampleStepMs
            while cursor < samples.count - 2, samples[cursor + 1].timestampMs < target {
                cursor += 1
            }
            let left = samples[cursor]
            let right = samples[cursor + 1]
            let width = right.timestampMs - left.timestampMs
            let ratio = width <= 0 ? 0 : (target - left.timestampMs) / width
            values.append(left.value + (right.value - left.value) * clamp(ratio, 0, 1))
        }
        return values
    }

    /// Centred moving average with edge truncation: at the edges only the
    /// samples that exist are averaged. No padding and no reflection, so the
    /// operation is fully specified.
    static func movingAverage(_ values: [Double], window: Int) -> [Double] {
        guard window > 1 else { return values }
        let half = window / 2
        var averaged: [Double] = []
        averaged.reserveCapacity(values.count)
        for index in values.indices {
            let start = max(0, index - half)
            let end = min(values.count - 1, index + half)
            var total = 0.0
            for cursor in start...end { total += values[cursor] }
            averaged.append(total / Double(end - start + 1))
        }
        return averaged
    }

    /// Normalized autocorrelation over a lag band, with subharmonic suppression
    /// and parabolic peak refinement.
    static func periodicity(
        _ filtered: [Double],
        minLag: Int,
        maxLag: Int
    ) -> Periodicity {
        guard filtered.count > minLag + 1, minLag >= 1, maxLag >= minLag else {
            return Periodicity(periodicity: 0, refinedLag: nil)
        }
        let highestLag = min(maxLag, filtered.count - 2)
        guard highestLag >= minLag else {
            return Periodicity(periodicity: 0, refinedLag: nil)
        }

        var correlations: [Double] = []
        correlations.reserveCapacity(highestLag - minLag + 1)
        for lag in minLag...highestLag {
            correlations.append(correlation(filtered, lag: lag))
        }

        var bestIndex = 0
        for index in 1..<correlations.count where correlations[index] > correlations[bestIndex] {
            bestIndex = index
        }

        // Autocorrelation peaks just as strongly at whole multiples of the true
        // period, so an unguarded maximum reports half or a third of the real
        // rate. A genuine subharmonic correlates comparably at lag/k; a false
        // one lands antiphase and correlates negatively.
        let peakIndex = bestIndex
        let peak = correlations[peakIndex]
        for divisor in [3, 2] {
            let candidateLag = Int(
                (Double(minLag + peakIndex) / Double(divisor)).rounded()
            )
            let candidateIndex = candidateLag - minLag
            guard candidateIndex >= 0, candidateIndex < correlations.count else { continue }
            if correlations[candidateIndex] >= PhysiologyTuning.subharmonicRatio * peak {
                bestIndex = candidateIndex
                break
            }
        }

        let best = correlations[bestIndex]
        let bestLag = minLag + bestIndex

        var offset = 0.0
        if bestIndex > 0, bestIndex < correlations.count - 1 {
            let before = correlations[bestIndex - 1]
            let after = correlations[bestIndex + 1]
            let denominator = before - 2 * best + after
            // Without the clamp a nearly flat correlation curve produces an
            // enormous offset and a fabricated rate.
            offset =
                abs(denominator) < 1e-12
                ? 0 : clamp((0.5 * (before - after)) / denominator, -0.5, 0.5)
        }

        return Periodicity(
            periodicity: max(0, best),
            refinedLag: Double(bestLag) + offset
        )
    }

    private static func correlation(_ values: [Double], lag: Int) -> Double {
        var cross = 0.0
        var energyA = 0.0
        var energyB = 0.0
        var index = 0
        while index + lag < values.count {
            let a = values[index]
            let b = values[index + lag]
            cross += a * b
            energyA += a * a
            energyB += b * b
            index += 1
        }
        let denominator = (energyA * energyB).squareRoot()
        return denominator < 1e-12 ? 0 : cross / denominator
    }

    static func ratePerMinute(fromLag lag: Double) -> Double {
        (60 * PhysiologyTuning.resampleHz) / lag
    }

    /// Mean absolute first difference of the resampled signal, scaled and clamped.
    static func motion(_ resampled: [Double], scale: Double) -> Double {
        guard resampled.count >= 2 else { return 1 }
        var total = 0.0
        for index in 1..<resampled.count {
            total += abs(resampled[index] - resampled[index - 1])
        }
        return min(1, total / Double(resampled.count - 1) / scale)
    }

    /// Nearest-rank percentile, which needs no interpolation convention.
    static func percentile(_ values: [Double], _ fraction: Double) -> Double {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        let index = Int((fraction * Double(sorted.count - 1)).rounded(.down))
        return sorted[index]
    }

    static func amplitude(_ filtered: [Double], _ resampled: [Double]) -> Double {
        guard !filtered.isEmpty else { return 0 }
        var total = 0.0
        for value in resampled { total += value }
        let mean = resampled.isEmpty ? 0 : total / Double(resampled.count)
        let span = percentile(filtered, 0.95) - percentile(filtered, 0.05)
        return span / max(abs(mean), 1e-6)
    }

    /// Spread of per-window rates, mapped to `0...1`. When the signal is too
    /// short to fit two windows the result is zero: a session that cannot
    /// demonstrate stability does not get to claim it.
    static func stability(_ filtered: [Double], options: StabilityOptions) -> Double {
        var rates: [Double] = []
        var start = 0
        while start + options.windowSamples <= filtered.count {
            let window = Array(filtered[start..<(start + options.windowSamples)])
            let result = periodicity(window, minLag: options.minLag, maxLag: options.maxLag)
            if let lag = result.refinedLag {
                rates.append(ratePerMinute(fromLag: lag))
            }
            start += options.stepSamples
        }
        guard rates.count >= 2 else { return 0 }

        var lowest = rates[0]
        var highest = rates[0]
        for rate in rates {
            if rate < lowest { lowest = rate }
            if rate > highest { highest = rate }
        }
        return 1 - min(1, (highest - lowest) / options.scale)
    }

    static func qualityBand(_ score: Double) -> QualityBand {
        if score >= PhysiologyTuning.qualityGoodScore { return .good }
        if score >= PhysiologyTuning.qualityFairScore { return .fair }
        return .poor
    }

    static func confidence(
        periodicity: Double,
        stability: Double,
        durationMs: Double,
        fullDurationMs: Double
    ) -> Double {
        let durationFactor = clamp(durationMs / fullDurationMs, 0, 1)
        return clamp(0.5 * periodicity + 0.3 * stability + 0.2 * durationFactor, 0, 1)
    }

    static func confidenceBand(_ confidence: Double) -> ConfidenceBand {
        if confidence >= PhysiologyTuning.confidenceHigh { return .high }
        if confidence >= PhysiologyTuning.confidenceModerate { return .moderate }
        return .low
    }

    static func effectiveSampleRateHz(sampleCount: Int, durationMs: Double) -> Double {
        guard sampleCount >= 2, durationMs > 0 else { return 0 }
        return (Double(sampleCount - 1) * 1000) / durationMs
    }
}

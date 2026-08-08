import Foundation

/// Speaker profile — `engines/speaker-profile/SPEC.md`.
///
/// It tells the enrolled person's voice apart from a clearly different one, so
/// a partner or a stranger speaking into the same phone does not take a turn.
///
/// It is **not** authentication. A similar voice passes it, a recording of the
/// enrolled voice passes it, and a cold may fail it. Nothing may use it as a
/// security control and no interface may describe it as recognising who someone
/// is.
enum SpeakerTuning {
    static let sampleRateHz = 16_000.0
    static let voicedMinRms = 0.012
    static let f0MinHz = 70.0
    static let f0MaxHz = 350.0
    static let minPeakCorrelation = 0.30
    static let minEnrolmentFrames = 150
    static let f0SpreadFloor = 8.0
    static let tiltScale = 1.2
    static let zcrScale = 0.08
    static let matchThreshold = 2.6
    static let decisionWindow = 25
    static let minDecidingFrames = 8
    static let rejectRatio = 0.65

    static let weightF0 = 2.0
    static let weightTiltMidLow = 1.0
    static let weightTiltHighMid = 1.0
    static let weightZcr = 0.5
}

struct SpeakerFrame: Sendable, Equatable {
    var rms: Double
    var f0Hz: Double
    var tiltMidLow: Double
    var tiltHighMid: Double
    var zcr: Double
}

struct SpeakerProfile: Sendable, Equatable {
    var f0Hz: Double
    var f0Spread: Double
    var tiltMidLow: Double
    var tiltHighMid: Double
    var zcr: Double
    var frames: Int
}

enum SpeakerVerdict: String, Sendable {
    case enrolled
    case other
    case unknown
}

struct SpeakerDecision: Sendable {
    var verdict: SpeakerVerdict
    var matchRatio: Double
    var frames: Int
}

enum SpeakerFeatures {
    /// One-pole low pass. Chosen over a designed filter because the recurrence
    /// is exactly reproducible in three languages with no coefficient tables.
    static func lowPass(_ samples: [Double], cutoffHz: Double) -> [Double] {
        let dt = 1 / SpeakerTuning.sampleRateHz
        let rc = 1 / (2 * Double.pi * cutoffHz)
        let alpha = dt / (rc + dt)
        var out = [Double](repeating: 0, count: samples.count)
        var previous = 0.0
        for index in samples.indices {
            previous += alpha * (samples[index] - previous)
            out[index] = previous
        }
        return out
    }

    static func energy(_ samples: [Double]) -> Double {
        guard !samples.isEmpty else { return 0 }
        var total = 0.0
        for value in samples { total += value * value }
        return total / Double(samples.count)
    }

    /// Fundamental by autocorrelation, with the peak's own strength. The
    /// strength is what separates a pitch from noise that happens to have a
    /// maximum somewhere.
    static func fundamental(_ samples: [Double]) -> (f0Hz: Double, peak: Double) {
        let minLag = Int(SpeakerTuning.sampleRateHz / SpeakerTuning.f0MaxHz)
        let maxLag = min(
            samples.count - 1,
            Int(ceil(SpeakerTuning.sampleRateHz / SpeakerTuning.f0MinHz))
        )
        guard maxLag > minLag else { return (0, 0) }

        var zeroLag = 0.0
        for value in samples { zeroLag += value * value }
        guard zeroLag > 0 else { return (0, 0) }

        var bestLag = 0
        var bestValue = 0.0
        for lag in minLag...maxLag {
            var sum = 0.0
            var index = 0
            while index + lag < samples.count {
                sum += samples[index] * samples[index + lag]
                index += 1
            }
            let normalised = sum / zeroLag
            if normalised > bestValue {
                bestValue = normalised
                bestLag = lag
            }
        }
        guard bestLag > 0 else { return (0, 0) }
        return (SpeakerTuning.sampleRateHz / Double(bestLag), bestValue)
    }

    /// Features for one frame, or `nil` when it is not voiced.
    ///
    /// Unvoiced frames are discarded rather than given neutral values: neutral
    /// values would drag every profile towards the same place and make two
    /// speakers look alike.
    static func frame(_ samples: [Double]) -> SpeakerFrame? {
        guard samples.count >= 64 else { return nil }

        let rms = energy(samples).squareRoot()
        guard rms >= SpeakerTuning.voicedMinRms else { return nil }

        let pitch = fundamental(samples)
        guard pitch.peak >= SpeakerTuning.minPeakCorrelation else { return nil }
        guard pitch.f0Hz >= SpeakerTuning.f0MinHz, pitch.f0Hz <= SpeakerTuning.f0MaxHz else {
            return nil
        }

        let below500 = lowPass(samples, cutoffHz: 500)
        let below2000 = lowPass(samples, cutoffHz: 2000)
        let lowEnergy = energy(below500)
        let midEnergy = max(0, energy(below2000) - lowEnergy)
        let highEnergy = max(0, energy(samples) - energy(below2000))

        // A floor rather than a guard: silence in one band is a real
        // observation about a voice, and log2 of zero is not.
        let floor = 1e-9
        let tiltMidLow = log2((midEnergy + floor) / (lowEnergy + floor))
        let tiltHighMid = log2((highEnergy + floor) / (midEnergy + floor))

        var crossings = 0
        for index in 1..<samples.count {
            let previous = samples[index - 1]
            let current = samples[index]
            if (previous >= 0 && current < 0) || (previous < 0 && current >= 0) {
                crossings += 1
            }
        }

        return SpeakerFrame(
            rms: rms,
            f0Hz: pitch.f0Hz,
            tiltMidLow: tiltMidLow,
            tiltHighMid: tiltHighMid,
            zcr: Double(crossings) / Double(samples.count)
        )
    }

    private static func median(_ values: [Double]) -> Double {
        let sorted = values.sorted()
        let middle = sorted.count / 2
        if sorted.count % 2 == 1 { return sorted[middle] }
        return (sorted[middle - 1] + sorted[middle]) / 2
    }

    private static func mean(_ values: [Double]) -> Double {
        guard !values.isEmpty else { return 0 }
        return values.reduce(0, +) / Double(values.count)
    }

    /// Builds a profile, or `nil` when there is not enough voiced speech. Too
    /// little produces nothing rather than something weak: a weak profile does
    /// not fail loudly, it quietly matches everyone.
    static func profile(from frames: [SpeakerFrame]) -> SpeakerProfile? {
        guard frames.count >= SpeakerTuning.minEnrolmentFrames else { return nil }

        let f0Values = frames.map(\.f0Hz)
        let centre = median(f0Values)
        // Median absolute deviation, not standard deviation: one shouted word
        // should not move a profile.
        let spread = max(
            SpeakerTuning.f0SpreadFloor,
            median(f0Values.map { abs($0 - centre) })
        )

        return SpeakerProfile(
            f0Hz: centre,
            f0Spread: spread,
            tiltMidLow: mean(frames.map(\.tiltMidLow)),
            tiltHighMid: mean(frames.map(\.tiltHighMid)),
            zcr: mean(frames.map(\.zcr)),
            frames: frames.count
        )
    }

    /// Distance in units of the enrolled speaker's own variation.
    static func distance(_ frame: SpeakerFrame, _ profile: SpeakerProfile) -> Double {
        let d0 = abs(frame.f0Hz - profile.f0Hz) / profile.f0Spread
        let d1 = abs(frame.tiltMidLow - profile.tiltMidLow) / SpeakerTuning.tiltScale
        let d2 = abs(frame.tiltHighMid - profile.tiltHighMid) / SpeakerTuning.tiltScale
        let d3 = abs(frame.zcr - profile.zcr) / SpeakerTuning.zcrScale
        return
            (SpeakerTuning.weightF0 * d0 * d0
            + SpeakerTuning.weightTiltMidLow * d1 * d1
            + SpeakerTuning.weightTiltHighMid * d2 * d2
            + SpeakerTuning.weightZcr * d3 * d3).squareRoot()
    }
}

/// Answers on the balance of a short history, never on one frame.
///
/// `unknown` is a real answer and callers must transmit on it: being unheard is
/// worse than occasionally answering someone else.
final class SpeakerMatcher {
    private let profile: SpeakerProfile?
    private var history: [Bool] = []

    init(profile: SpeakerProfile?) {
        self.profile = profile
    }

    /// Every frame is offered; only voiced ones reach a verdict.
    func accept(_ frame: SpeakerFrame?) -> SpeakerDecision {
        if let profile, let frame {
            history.append(SpeakerFeatures.distance(frame, profile) <= SpeakerTuning.matchThreshold)
            if history.count > SpeakerTuning.decisionWindow { history.removeFirst() }
        }

        let frames = history.count
        guard profile != nil, frames >= SpeakerTuning.minDecidingFrames else {
            return SpeakerDecision(verdict: .unknown, matchRatio: 1, frames: frames)
        }

        let matches = history.filter { $0 }.count
        let matchRatio = Double(matches) / Double(frames)
        return SpeakerDecision(
            verdict: 1 - matchRatio >= SpeakerTuning.rejectRatio ? .other : .enrolled,
            matchRatio: matchRatio,
            frames: frames
        )
    }

    func reset() {
        history.removeAll()
    }
}

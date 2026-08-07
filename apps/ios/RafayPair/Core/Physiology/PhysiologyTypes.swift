import Foundation

/// Canonical physiology types.
///
/// Normative definitions live in `engines/signal-quality/SPEC.md`,
/// `engines/pulse-estimation-spec/SPEC.md`,
/// `engines/breathing-estimation-spec/SPEC.md`, and
/// `engines/calorie-estimation-spec/SPEC.md`. This is an independent Swift
/// implementation; the golden vectors in `tests/golden` hold it in agreement
/// with the Kotlin and TypeScript engines.

enum QualityBand: String, Sendable {
    case poor
    case fair
    case good
}

enum ConfidenceBand: String, Sendable {
    case low
    case moderate
    case high
}

struct SignalQuality: Sendable, Equatable {
    var score: Double
    var band: QualityBand
    var coverage: Double
    var motion: Double
    var periodicity: Double
    var amplitude: Double
    var stability: Double

    static let empty = SignalQuality(
        score: 0, band: .poor, coverage: 0, motion: 1,
        periodicity: 0, amplitude: 0, stability: 0
    )
}

/// A single frame reduced to the two channel means the estimator needs. Raw
/// frames are never retained; the capture layer produces these and releases the
/// buffer.
struct PulseSample: Sendable {
    var timestampMs: Double
    /// Mean red channel over the region of interest, `0...255`.
    var red: Double
    /// Mean green channel over the region of interest, `0...255`.
    var green: Double
}

enum PulseRejectionReason: String, Sendable {
    case tooShort
    case fingerNotDetected
    case excessiveMotion
    case noPeriodicity
    case unstable
    case outOfRange
}

/// Provenance is part of the type, not a convention. There is no case that can
/// carry a measured-grade reading, so nothing downstream can promote an
/// estimate, and no blood-pressure value is derived anywhere.
struct MeasuredPulse: Sendable, Equatable {
    var bpm: Double
    var durationMs: Double
    var sampleCount: Int
    var effectiveSampleRateHz: Double
    var quality: SignalQuality
    var confidence: Double
    var confidenceBand: ConfidenceBand
    var measuredAtMs: Double

    let source = "phone_camera_ppg"
    let kind = "app_estimated"

    static func == (lhs: MeasuredPulse, rhs: MeasuredPulse) -> Bool {
        lhs.bpm == rhs.bpm && lhs.measuredAtMs == rhs.measuredAtMs
            && lhs.durationMs == rhs.durationMs
    }
}

enum PulseResult: Sendable {
    case measured(MeasuredPulse)
    case rejected(
        reason: PulseRejectionReason,
        durationMs: Double,
        sampleCount: Int,
        quality: SignalQuality
    )

    var statusName: String {
        switch self {
        case .measured: "measured"
        case .rejected: "rejected"
        }
    }

    var quality: SignalQuality {
        switch self {
        case .measured(let pulse): pulse.quality
        case .rejected(_, _, _, let quality): quality
        }
    }

    var sampleCount: Int {
        switch self {
        case .measured(let pulse): pulse.sampleCount
        case .rejected(_, _, let count, _): count
        }
    }

    var durationMs: Double {
        switch self {
        case .measured(let pulse): pulse.durationMs
        case .rejected(_, let duration, _, _): duration
        }
    }
}

/// One frame of the pose-derived breathing signal.
struct BreathingSample: Sendable {
    var timestampMs: Double
    /// Shoulder-centre height divided by torso scale; distance-invariant.
    var chestOffset: Double
    /// Whether the pose engine considered the source frame valid.
    var tracked: Bool
}

enum BreathingRejectionReason: String, Sendable {
    case tooShort
    case notTracked
    case excessiveMotion
    case noPeriodicity
    case unstable
    case outOfRange
}

struct MeasuredBreathing: Sendable {
    var breathsPerMinute: Double
    var durationMs: Double
    var sampleCount: Int
    var effectiveSampleRateHz: Double
    var quality: SignalQuality
    var confidence: Double
    var confidenceBand: ConfidenceBand
    var measuredAtMs: Double

    let source = "phone_camera_motion"
    let kind = "app_estimated"
}

enum BreathingResult: Sendable {
    case measured(MeasuredBreathing)
    case rejected(
        reason: BreathingRejectionReason,
        durationMs: Double,
        sampleCount: Int,
        quality: SignalQuality
    )

    var statusName: String {
        switch self {
        case .measured: "measured"
        case .rejected: "rejected"
        }
    }

    var quality: SignalQuality {
        switch self {
        case .measured(let breathing): breathing.quality
        case .rejected(_, _, _, let quality): quality
        }
    }

    var sampleCount: Int {
        switch self {
        case .measured(let breathing): breathing.sampleCount
        case .rejected(_, _, let count, _): count
        }
    }
}

struct BreathingPattern: Sendable, Equatable {
    var inhaleMs: Double
    var holdMs: Double
    var exhaleMs: Double
    var holdAfterMs: Double
    var cycles: Int

    /// Longer exhale than inhale; the pattern that settles arousal.
    static func calm(cycles: Int) -> BreathingPattern {
        BreathingPattern(
            inhaleMs: 4000, holdMs: 0, exhaleMs: 6000, holdAfterMs: 0, cycles: cycles
        )
    }

    static func box(cycles: Int) -> BreathingPattern {
        BreathingPattern(
            inhaleMs: 4000, holdMs: 4000, exhaleMs: 4000, holdAfterMs: 4000, cycles: cycles
        )
    }

    static func relax(cycles: Int) -> BreathingPattern {
        BreathingPattern(
            inhaleMs: 4000, holdMs: 7000, exhaleMs: 8000, holdAfterMs: 0, cycles: cycles
        )
    }
}

enum BreathingPhase: String, Sendable {
    case inhale
    case hold
    case exhale
    case holdAfter
    case complete
}

struct BreathingPhaseState: Sendable, Equatable {
    var phase: BreathingPhase
    var cycleIndex: Int
    /// Progress through the current phase, `0...1`. Always 1 when complete.
    var progress: Double
    var remainingMs: Double
}

/// One frame of the face-derived rPPG signal.
///
/// No image is retained: the capture layer produces these six numbers and
/// releases the buffer, exactly as the fingertip path does.
struct FaceRppgSample: Sendable {
    var timestampMs: Double
    /// Mean green channel over the facial region, `0...255`.
    var green: Double
    /// Mean brightness of the same region; drives the lighting gate.
    var luma: Double
    /// Detected face box area as a fraction of the frame.
    var faceArea: Double
    var faceCenterX: Double
    var faceCenterY: Double
}

enum FaceRppgRejectionReason: String, Sendable {
    case tooShort
    case faceNotStable
    case unstableLighting
    case excessiveMotion
    case noPeriodicity
    case unstable
    case outOfRange
}

/// `experimental` is fixed on the type, so no consumer can strip the caveat.
/// Specification §6 forbids this result from the heart visualization, the
/// consent-gated share, and the stored latest pulse.
struct MeasuredFaceRppg: Sendable {
    var bpm: Double
    var durationMs: Double
    var sampleCount: Int
    var effectiveSampleRateHz: Double
    var quality: SignalQuality
    var lumaSwing: Double
    var confidence: Double
    var confidenceBand: ConfidenceBand
    var measuredAtMs: Double

    let source = "face_camera_rppg"
    let kind = "app_estimated"
    let experimental = true
}

enum FaceRppgResult: Sendable {
    case measured(MeasuredFaceRppg)
    case rejected(
        reason: FaceRppgRejectionReason,
        durationMs: Double,
        sampleCount: Int,
        quality: SignalQuality,
        lumaSwing: Double
    )

    var statusName: String {
        switch self {
        case .measured: "measured"
        case .rejected: "rejected"
        }
    }

    var quality: SignalQuality {
        switch self {
        case .measured(let result): result.quality
        case .rejected(_, _, _, let quality, _): quality
        }
    }

    var sampleCount: Int {
        switch self {
        case .measured(let result): result.sampleCount
        case .rejected(_, _, let count, _, _): count
        }
    }

    var lumaSwing: Double {
        switch self {
        case .measured(let result): result.lumaSwing
        case .rejected(_, _, _, _, let swing): swing
        }
    }
}

/// One hop of microphone-derived features.
///
/// This type deliberately carries no audio. It is the boundary the retention
/// rule is enforced at: three scalars at 30 Hz, from which no intelligible
/// content is reconstructible.
struct AudioHopFeature: Sendable {
    var timestampMs: Double
    /// Root-mean-square energy of the band-passed hop.
    var rms: Double
    var zeroCrossingRate: Double
    /// Peak absolute amplitude before filtering, used to detect clipping.
    var peak: Double
}

enum AudioBreathingRejectionReason: String, Sendable {
    case tooShort
    case notAudible
    case tooNoisy
    case noPeriodicity
    case unstable
    case outOfRange
}

struct MeasuredAudioBreathing: Sendable {
    var breathsPerMinute: Double
    var durationMs: Double
    var hopCount: Int
    var effectiveSampleRateHz: Double
    var quality: SignalQuality
    var confidence: Double
    var confidenceBand: ConfidenceBand
    var measuredAtMs: Double

    let source = "phone_microphone"
    let kind = "app_estimated"
}

enum AudioBreathingResult: Sendable {
    case measured(MeasuredAudioBreathing)
    case rejected(
        reason: AudioBreathingRejectionReason,
        durationMs: Double,
        hopCount: Int,
        quality: SignalQuality
    )

    var statusName: String {
        switch self {
        case .measured: "measured"
        case .rejected: "rejected"
        }
    }

    var quality: SignalQuality {
        switch self {
        case .measured(let breathing): breathing.quality
        case .rejected(_, _, _, let quality): quality
        }
    }

    var hopCount: Int {
        switch self {
        case .measured(let breathing): breathing.hopCount
        case .rejected(_, _, let count, _): count
        }
    }
}

enum CalorieActivity: String, Sendable {
    case rest
    case guidedBreathing
    case squat
    case bodyweightMixed
    case walkingInPlace
}

enum CalorieInput: String, Sendable {
    case duration
    case repetitions
    case bodyMass
    case poseConfidence
}

enum CalorieBandLabel: String, Sendable {
    case moderate
    case wide
    case veryWide
}

struct CalorieEstimateInput: Sendable {
    var activity: CalorieActivity
    var durationMs: Double
    var repetitions: Int?
    /// Only present when the user chose to provide it.
    var bodyMassKg: Double?
    var poseConfidence: Double?
}

struct CalorieEstimate: Sendable {
    var estimatedKcal: Double
    var algorithmVersion: String
    var activity: CalorieActivity
    var durationMs: Double
    var repetitions: Int
    var met: Double
    var bodyMassKg: Double
    var inputsUsed: [CalorieInput]
    var lowKcal: Double
    var highKcal: Double
    var bandLabel: CalorieBandLabel
}

/// Every tunable, mirroring `packages/physiology-engine/src/constants.ts`.
enum PhysiologyTuning {
    static let resampleHz = 30.0
    static let resampleStepMs = 1000.0 / 30.0

    static let qualityGoodScore = 0.75
    static let qualityFairScore = 0.5
    static let confidenceHigh = 0.7
    static let confidenceModerate = 0.45
    /// One physical event per signal cycle — a heartbeat, a chest rise.
    static let subharmonicRatio = 0.85
    /// Two energy bursts per physical cycle — breath sound, loud on the inhale
    /// and again on the exhale.
    static let subharmonicMargin = 0.02

    // Face-camera rPPG, research mode — engines/pulse-estimation-spec/FACE_RPPG.md
    /// Off by default. Master specification §3.3 requires this mode to be
    /// experimental and removable; the flag is the single switch.
    static let faceRppgEnabled = false

    static let faceDetrendWindowSamples = 61
    static let faceSmoothWindowSamples = 7
    static let faceMinBpm = 42.0
    static let faceMaxBpm = 180.0

    static let faceMinLuma = 60.0
    static let faceMaxLuma = 235.0
    static let faceMinArea = 0.04
    static let faceMaxCenterShift = 0.03
    static let faceMaxLumaSwing = 0.18

    static let faceMotionScale = 4.0
    static let faceStabilityWindowSamples = 240
    static let faceStabilityStepSamples = 60
    static let faceStabilityScale = 15.0
    static let faceConfidenceFullDurationMs = 40_000.0

    static let faceMinDurationMs = 15_000.0
    static let faceMaxDurationMs = 60_000.0
    /// Stricter than the fingertip path throughout: a weaker signal earns less
    /// benefit of the doubt, not more.
    static let faceMinCoverage = 0.85
    static let faceMinPeriodicity = 0.6
    static let faceMaxMotion = 0.3
    static let faceMinStability = 0.45

    static let audioSampleRateHz = 16_000.0
    static let audioHighPassHz = 200.0
    static let audioLowPassHz = 2_000.0
    static let audioHopSamples = 533

    static let audioRmsFloor = 0.0015
    static let audioPeakClip = 0.98
    static let audioZcrMin = 0.02
    static let audioZcrMax = 0.45

    static let micMotionScale = 0.05
    static let micConfidenceFullDurationMs = 45_000.0
    static let micMinDurationMs = 20_000.0
    /// Lower than the camera estimate: calm breathing legitimately has quiet gaps.
    static let micMinCoverage = 0.6
    static let micMinPeriodicity = 0.4
    static let micMaxMotion = 0.6
    static let micMinStability = 0.3

    static let fingerMinRed = 60.0
    static let fingerMaxGreen = 190.0
    static let fingerMinRedExcess = 25.0

    static let pulseDetrendWindowSamples = 31
    static let pulseSmoothWindowSamples = 5
    static let pulseMinBpm = 42.0
    static let pulseMaxBpm = 210.0

    static let pulseMotionScale = 6.0
    static let pulseStabilityWindowSamples = 150
    static let pulseStabilityStepSamples = 45
    static let pulseStabilityScale = 20.0
    static let pulseConfidenceFullDurationMs = 20_000.0

    static let pulseMinDurationMs = 8_000.0
    static let pulseMaxDurationMs = 45_000.0
    static let pulseMinCoverage = 0.9
    static let pulseMinPeriodicity = 0.45
    static let pulseMaxMotion = 0.35
    static let pulseMinStability = 0.3

    static let pulseFreshnessMs = 300_000.0

    static let breathingDetrendWindowSamples = 301
    static let breathingSmoothWindowSamples = 25
    static let breathingMinPerMinute = 6.0
    static let breathingMaxPerMinute = 36.0

    static let breathingMotionScale = 0.4
    static let breathingStabilityWindowSamples = 450
    static let breathingStabilityStepSamples = 150
    static let breathingStabilityScale = 6.0
    static let breathingConfidenceFullDurationMs = 45_000.0

    static let breathingMinDurationMs = 20_000.0
    static let breathingMinCoverage = 0.8
    static let breathingMinPeriodicity = 0.4
    static let breathingMaxMotion = 0.5
    static let breathingMinStability = 0.3

    static let calorieAlgorithmVersion = "1.0.0"
    static let defaultBodyMassKg = 70.0
    static let metRest = 1.3
    static let metGuidedBreathing = 1.3
    static let metSquat = 5.0
    static let metBodyweightMixed = 4.5
    static let metWalkingInPlace = 3.5
    static let calorieFullIntensityRepsPerMinute = 20.0
    static let calorieBaseUncertainty = 0.25
    static let calorieNoBodyMassPenalty = 0.2
    static let calorieShortSessionPenalty = 0.1
    static let calorieLowConfidencePenalty = 0.15
    static let calorieShortSessionMs = 60_000.0
    static let calorieLowPoseConfidence = 0.5
    static let calorieMaxUncertainty = 0.75
}

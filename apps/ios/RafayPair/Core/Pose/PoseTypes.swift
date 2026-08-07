import Foundation

/// Canonical pose types.
///
/// Normative definitions live in `engines/pose-spec/SPEC.md`. This is an
/// independent Swift implementation of that document; it shares no code with
/// the Kotlin or TypeScript engines, and the golden vectors in `tests/golden`
/// are what hold the three in agreement.

/// The thirteen joints common to Apple Vision, ML Kit Pose Detection, and
/// BlazePose. The order is normative: golden vectors pack joints in exactly
/// this sequence.
enum JointName: Int, CaseIterable, Sendable {
    case nose
    case leftShoulder
    case rightShoulder
    case leftElbow
    case rightElbow
    case leftWrist
    case rightWrist
    case leftHip
    case rightHip
    case leftKnee
    case rightKnee
    case leftAnkle
    case rightAnkle

    /// Joints that must all be usable for a frame to be valid.
    static let core: [JointName] = [
        .leftShoulder, .rightShoulder,
        .leftHip, .rightHip,
        .leftKnee, .rightKnee,
        .leftAnkle, .rightAnkle,
    ]
}

struct Joint: Sendable, Equatable {
    /// Image-normalized horizontal position; origin top-left, grows right.
    var x: Double
    /// Image-normalized vertical position; origin top-left, grows down.
    var y: Double
    /// Detector confidence in `0...1`.
    var visibility: Double
}

struct PoseFrame: Sendable {
    /// Monotonic milliseconds.
    var timestampMs: Double
    /// Indexed by `JointName.rawValue`; always `JointName.allCases.count` long.
    var joints: [Joint]

    func joint(_ name: JointName) -> Joint {
        joints[name.rawValue]
    }
}

enum Posture: String, Sendable {
    case unknown
    case lying
    case standing
    case crouched
    case transitional
}

struct PoseObservation: Sendable {
    var timestampMs: Double
    var valid: Bool
    var posture: Posture
    var torsoAngleDeg: Double
    var meanKneeAngle: Double
    var meanHipAngle: Double
    var leftKneeAngle: Double
    var rightKneeAngle: Double
    var hipElevation: Double
    var minVisibility: Double
    var framingOk: Bool
}

/// Posture as presented to the product, after temporal disambiguation.
enum ReportedPosture: String, Sendable, CaseIterable {
    case unknown
    case standing
    case sitting
    case lyingDown
    case squatting
}

enum FormEvent: String, Sendable, CaseIterable {
    case shallowDepth
    case forwardLean
    case uneven
}

struct Repetition: Sendable, Equatable {
    var index: Int
    var startMs: Double
    var endMs: Double
    var durationMs: Double
    var minElevation: Double
    var depth: Double
    var formEvents: [FormEvent]
}

enum SquatPhase: String, Sendable {
    case idle
    case descending
    case bottom
}

struct ExerciseObservation: Sendable {
    var timestampMs: Double
    var reportedPosture: ReportedPosture
    var squatPhase: SquatPhase
    var repetitionCount: Int
    /// Present only on the frame that completes a repetition.
    var completedRepetition: Repetition?
}

struct SessionSummary: Sendable {
    var startedAtMs: Double
    var endedAtMs: Double
    var repetitions: [Repetition]
    var repetitionCount: Int
    var bestDepth: Double
    var averageDurationMs: Double
    var postureTimelineMs: [ReportedPosture: Double]
    var formEventCounts: [FormEvent: Int]
}

/// Every tunable, mirroring `packages/pose-engine/src/constants.ts`. Changing a
/// value here without changing it everywhere breaks the golden vectors, which
/// is exactly the intent.
enum PoseTuning {
    static let minVisibility = 0.5
    static let minTorsoScale = 0.02
    static let smoothingAlpha = 0.4

    static let lyingTorsoAngleDeg = 60.0
    static let standingHipElevation = 1.3
    static let standingKneeAngle = 150.0
    static let crouchedHipElevation = 1.15
    static let crouchedKneeAngle = 135.0

    static let sitHoldMs = 2500.0
    static let sitStabilityBand = 0.12
    static let lieHoldMs = 1200.0
    static let standHoldMs = 400.0

    static let squatTopElevation = 1.3
    static let squatBottomElevation = 1.05
    static let squatMinCycleMs = 500.0
    static let squatMaxCycleMs = 8000.0

    static let staleFrameMs = 1500.0

    static let shallowDepthMargin = 0.05
    static let forwardLeanDeg = 45.0
    static let unevenKneeDeg = 25.0
}

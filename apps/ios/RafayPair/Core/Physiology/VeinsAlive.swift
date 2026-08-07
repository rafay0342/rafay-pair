import Foundation

/// Veins Alive.
///
/// Master specification §8: a visual experience, with no claim of scanning
/// veins. Nothing here measures, infers, or predicts. It turns values the
/// product already holds into the handful of numbers a renderer needs, and it
/// is a type rather than a drawing detail because one of those numbers must be
/// allowed to be absent.
///
/// The absent one is the pulse. With no fresh estimate the animation rests: it
/// does not fall back to a plausible rate and does not keep beating at the last
/// one it saw. A vascular network pulsing at an invented 72 would be a
/// fabricated measurement wearing an animation's clothes.
enum VeinsMode: String, CaseIterable, Sendable {
    case calm
    case workout
    case recovery

    var title: String {
        switch self {
        case .calm: "Calm"
        case .workout: "Workout"
        case .recovery: "Recovery"
        }
    }

    var baselineIntensity: Double {
        switch self {
        case .calm: 0.15
        case .workout: 0.45
        case .recovery: 0.25
        }
    }
}

enum MuscleGroup: String, CaseIterable, Sendable {
    case chest
    case core
    case quadriceps
    case hamstrings
    case glutes
    case calves
    case shoulders
}

struct VeinsInput: Sendable {
    var mode: VeinsMode = .calm
    /// Beats per minute, and only when the estimate is still fresh. Freshness
    /// is decided before the value reaches here.
    var pulseBpm: Double?
    /// The phase of a running guided-breathing session, or `nil` when none is.
    var breathingPhase: BreathingPhase?
    /// Progress through that phase, `0...1`.
    var breathingProgress: Double = 0
    /// Repetitions per minute in the current set, or `nil` outside a workout.
    var repetitionsPerMinute: Double?
    var activeMuscles: [MuscleGroup] = []
}

struct VeinsDrivers: Sendable {
    /// Milliseconds per contraction, or `nil` to rest. `nil` is the honest
    /// state, not a failure: nothing current is known, so the renderer shows
    /// stillness rather than motion.
    var contractionPeriodMs: Double?
    /// How the rate reached the screen. There is no `measured` case.
    var pulseProvenance: PulseProvenance
    var chestGlow: Double
    var intensity: Double
    var activeMuscles: [MuscleGroup]
    var disclosure: String

    enum PulseProvenance: String, Sendable {
        case estimated
        case none
    }
}

enum VeinsAlive {
    /// Shown whenever the view is on screen. Never abbreviated by a caller.
    static let disclosure = "Sensor-driven visualization — not a medical scan."

    /// Repetitions per minute treated as full effort; above this it saturates.
    static let repetitionsAtFullIntensity = 30.0

    static func drivers(for input: VeinsInput) -> VeinsDrivers {
        // A rate outside what the pulse estimator itself will report is refused
        // rather than clamped: clamping would turn a wrong number into a
        // plausible one, which is the failure this type is shaped to avoid.
        let usable: Bool
        if let bpm = input.pulseBpm, bpm.isFinite, bpm >= 42, bpm <= 210 {
            usable = true
        } else {
            usable = false
        }

        let effort: Double
        if let repetitions = input.repetitionsPerMinute {
            effort = clamp01(repetitions / repetitionsAtFullIntensity)
        } else {
            effort = 0
        }

        var seen = Set<MuscleGroup>()
        let muscles = input.activeMuscles.filter { seen.insert($0).inserted }

        return VeinsDrivers(
            contractionPeriodMs: usable ? 60_000 / (input.pulseBpm ?? 1) : nil,
            pulseProvenance: usable ? .estimated : .none,
            chestGlow: glow(for: input.breathingPhase, progress: input.breathingProgress),
            intensity: clamp01(input.mode.baselineIntensity + effort * 0.55),
            activeMuscles: muscles,
            disclosure: disclosure
        )
    }

    /// Rises through the inhale, holds at full, falls through the exhale, and
    /// rests after. Outside a session the chest does not breathe on screen
    /// while the user is doing something else.
    private static func glow(for phase: BreathingPhase?, progress: Double) -> Double {
        let eased = clamp01(progress)
        switch phase {
        case .inhale: return eased
        case .hold: return 1
        case .exhale: return 1 - eased
        case .holdAfter, .complete, nil: return 0
        }
    }

    private static func clamp01(_ value: Double) -> Double {
        guard value.isFinite else { return 0 }
        return min(1, max(0, value))
    }
}

import Foundation
import Observation

/// The experiment flags.
///
/// Master specification §24 names six of them and requires that no experimental
/// physiological feature be enabled silently. This registry mirrors
/// `packages/experiment-flags` name for name; `ExperimentFlagsTests` fails if a
/// name or a default drifts from it.
enum ExperimentFlag: String, CaseIterable, Sendable {
    case cameraPpgFaceMode = "camera_ppg_face_mode"
    case cameraBreathingEstimate = "camera_breathing_estimate"
    case microphoneBreathingEstimate = "microphone_breathing_estimate"
    case advancedFormCoaching = "advanced_form_coaching"
    case livingBodyAdvanced = "living_body_advanced"
    case aiRelationshipMemory = "ai_relationship_memory"

    var title: String {
        switch self {
        case .cameraPpgFaceMode: "Face-camera pulse"
        case .cameraBreathingEstimate: "Camera breathing estimate"
        case .microphoneBreathingEstimate: "Microphone breathing estimate"
        case .advancedFormCoaching: "Detailed form notes"
        case .livingBodyAdvanced: "Veins Alive"
        case .aiRelationshipMemory: "What Rafay remembers"
        }
    }

    var detail: String {
        switch self {
        case .cameraPpgFaceMode:
            "Estimates a pulse from colour change in the face. Far less reliable than the fingertip measurement, and refused outright when the lighting drifts."
        case .cameraBreathingEstimate:
            "Estimates a breathing rate from chest movement while you are already in frame. It says nothing rather than guessing when it cannot read you."
        case .microphoneBreathingEstimate:
            "Listens during a breathing session you started. Audio becomes a few numbers as it arrives and is never recorded."
        case .advancedFormCoaching:
            "Comments on squat depth, forward lean, and uneven weight. Observations about movement, not medical advice."
        case .livingBodyAdvanced:
            "An animated body view driven by what the app already knows. A visualization, not a scan."
        case .aiRelationshipMemory:
            "Lets the assistant keep notes you approve. You can read and delete every entry."
        }
    }

    /// Whether the feature estimates something about the body. These may never
    /// default to enabled, and the parity test enforces that.
    var isPhysiological: Bool {
        switch self {
        case .cameraPpgFaceMode, .cameraBreathingEstimate, .microphoneBreathingEstimate: true
        case .advancedFormCoaching, .livingBodyAdvanced, .aiRelationshipMemory: false
        }
    }

    /// Every experiment ships off. One that shipped enabled would not be an
    /// experiment, it would be a feature with a switch.
    var enabledByDefault: Bool { false }
}

/// Reads and writes the user's choices.
///
/// Stored on the device rather than on the server: an experiment is a property
/// of this install, and syncing it would turn one device's curiosity into
/// another device's surprise.
@MainActor
@Observable
final class ExperimentFlagStore {
    private let defaults: UserDefaults
    private(set) var choices: [ExperimentFlag: Bool] = [:]

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        for flag in ExperimentFlag.allCases {
            let key = Self.storageKey(flag)
            choices[flag] = defaults.object(forKey: key) as? Bool ?? flag.enabledByDefault
        }
    }

    func isEnabled(_ flag: ExperimentFlag) -> Bool {
        choices[flag] ?? flag.enabledByDefault
    }

    func set(_ flag: ExperimentFlag, enabled: Bool) {
        choices[flag] = enabled
        defaults.set(enabled, forKey: Self.storageKey(flag))
    }

    private static func storageKey(_ flag: ExperimentFlag) -> String {
        "rafaypair.experiment.\(flag.rawValue)"
    }
}

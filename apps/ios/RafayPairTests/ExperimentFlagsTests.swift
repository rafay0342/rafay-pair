import XCTest

@testable import RafayPair

/// Master specification §24, and parity with `packages/experiment-flags`.
///
/// The names are checked rather than described so a flag cannot be quietly
/// dropped or renamed on one platform only.
final class ExperimentFlagsTests: XCTestCase {
    func testDeclaresExactlyTheSixTheSpecificationNamesInOrder() {
        XCTAssertEqual(
            ExperimentFlag.allCases.map(\.rawValue),
            [
                "camera_ppg_face_mode",
                "camera_breathing_estimate",
                "microphone_breathing_estimate",
                "advanced_form_coaching",
                "living_body_advanced",
                "ai_relationship_memory",
            ]
        )
    }

    func testNoExperimentIsEnabledByDefault() {
        // "No experimental physiological feature may be enabled silently." A
        // default of true would make that sentence false, whatever the screen does.
        for flag in ExperimentFlag.allCases {
            XCTAssertFalse(flag.enabledByDefault, flag.rawValue)
        }
    }

    func testThePhysiologicalOnesAreMarkedAsSuch() {
        XCTAssertTrue(ExperimentFlag.cameraPpgFaceMode.isPhysiological)
        XCTAssertTrue(ExperimentFlag.cameraBreathingEstimate.isPhysiological)
        XCTAssertTrue(ExperimentFlag.microphoneBreathingEstimate.isPhysiological)
        XCTAssertFalse(ExperimentFlag.livingBodyAdvanced.isPhysiological)
    }

    func testEveryEntryExplainsItself() {
        for flag in ExperimentFlag.allCases {
            XCTAssertFalse(flag.title.isEmpty, flag.rawValue)
            XCTAssertGreaterThan(flag.detail.count, 40, flag.rawValue)
        }
    }

    @MainActor
    func testAChoiceSurvivesAndDefaultsToOff() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "rafaypair.tests.experiments"))
        defaults.removePersistentDomain(forName: "rafaypair.tests.experiments")

        let store = ExperimentFlagStore(defaults: defaults)
        XCTAssertFalse(store.isEnabled(.cameraBreathingEstimate))

        store.set(.cameraBreathingEstimate, enabled: true)
        XCTAssertTrue(store.isEnabled(.cameraBreathingEstimate))
        XCTAssertTrue(ExperimentFlagStore(defaults: defaults).isEnabled(.cameraBreathingEstimate))
    }
}

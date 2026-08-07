import XCTest

@testable import RafayPair

/// Cross-platform parity tests.
///
/// These read the same JSON vectors that the TypeScript and Kotlin engines
/// read. If this suite fails, the Swift engine has diverged from
/// `engines/pose-spec/SPEC.md` or `engines/exercise-state-machines/SPEC.md`.
final class PoseGoldenTests: XCTestCase {
    /// Continuous values are compared with the tolerance the specifications
    /// mandate: `atan2` is not guaranteed bit-identical across C libraries.
    private let tolerance = 1e-6

    // MARK: - Vector decoding

    private struct PackedFrame: Decodable {
        let t: Double
        let j: [Double]
    }

    private struct PoseExpectation: Decodable {
        let valid: Bool
        let posture: String
        let framingOk: Bool
        let torsoAngleDeg: Double
        let meanKneeAngle: Double
        let meanHipAngle: Double
        let hipElevation: Double
        let minVisibility: Double
    }

    private struct PoseCase: Decodable {
        let name: String
        let note: String
        let frame: PackedFrame
        let expected: PoseExpectation
    }

    private struct PoseVectors: Decodable {
        let cases: [PoseCase]
    }

    private struct RepetitionExpectation: Decodable {
        let index: Int
        let startMs: Double
        let endMs: Double
        let durationMs: Double
        let minElevation: Double
        let depth: Double
        let formEvents: [String]
    }

    private struct ExerciseExpectation: Decodable {
        let repetitionCount: Int
        let finalReportedPosture: String
        let repetitions: [RepetitionExpectation]
    }

    private struct ExerciseCase: Decodable {
        let name: String
        let note: String
        let frames: [PackedFrame]
        let expected: ExerciseExpectation
    }

    private func decode(_ packed: PackedFrame) throws -> PoseFrame {
        let expectedValues = JointName.allCases.count * 3
        try XCTSkipIf(
            packed.j.count != expectedValues,
            "Golden frame must carry \(expectedValues) values"
        )
        var joints: [Joint] = []
        joints.reserveCapacity(JointName.allCases.count)
        for index in JointName.allCases.indices {
            let offset = index * 3
            joints.append(
                Joint(
                    x: packed.j[offset],
                    y: packed.j[offset + 1],
                    visibility: packed.j[offset + 2]
                )
            )
        }
        return PoseFrame(timestampMs: packed.t, joints: joints)
    }

    private func loadVector<T: Decodable>(
        _ type: T.Type,
        named name: String,
        in subdirectory: String
    ) throws -> T {
        let bundle = Bundle(for: Self.self)
        let url = try XCTUnwrap(
            bundle.url(
                forResource: name,
                withExtension: "json",
                subdirectory: "golden/\(subdirectory)"
            ),
            "Missing golden vector golden/\(subdirectory)/\(name).json"
        )
        return try JSONDecoder().decode(type, from: Data(contentsOf: url))
    }

    // MARK: - Pose vectors

    func testStaticPostureVectors() throws {
        let vectors = try loadVector(
            PoseVectors.self,
            named: "static-postures",
            in: "pose"
        )
        XCTAssertFalse(vectors.cases.isEmpty)

        for testCase in vectors.cases {
            var engine = PoseEngine()
            let observation = engine.process(try decode(testCase.frame))
            let expected = testCase.expected

            XCTAssertEqual(observation.valid, expected.valid, testCase.name)
            XCTAssertEqual(observation.posture.rawValue, expected.posture, testCase.name)
            XCTAssertEqual(observation.framingOk, expected.framingOk, testCase.name)
            XCTAssertEqual(
                observation.torsoAngleDeg, expected.torsoAngleDeg,
                accuracy: tolerance, testCase.name
            )
            XCTAssertEqual(
                observation.meanKneeAngle, expected.meanKneeAngle,
                accuracy: tolerance, testCase.name
            )
            XCTAssertEqual(
                observation.meanHipAngle, expected.meanHipAngle,
                accuracy: tolerance, testCase.name
            )
            XCTAssertEqual(
                observation.hipElevation, expected.hipElevation,
                accuracy: tolerance, testCase.name
            )
            XCTAssertEqual(
                observation.minVisibility, expected.minVisibility,
                accuracy: tolerance, testCase.name
            )
        }
    }

    func testStaticVectorsCoverEveryClassification() throws {
        let vectors = try loadVector(
            PoseVectors.self,
            named: "static-postures",
            in: "pose"
        )
        let postures = Set(vectors.cases.map(\.expected.posture))
        XCTAssertEqual(
            postures,
            ["standing", "crouched", "lying", "transitional", "unknown"]
        )
    }

    // MARK: - Exercise vectors

    private static let exerciseVectorNames = [
        "bounce-too-fast",
        "deep-squat-forward-lean",
        "lie-down-and-hold",
        "partial-squat-no-depth",
        "sit-down-and-hold",
        "squat-then-sit",
        "standing-still",
        "three-squats",
    ]

    func testExerciseVectors() throws {
        for name in Self.exerciseVectorNames {
            let testCase = try loadVector(ExerciseCase.self, named: name, in: "exercise")
            var poseEngine = PoseEngine()
            var exerciseEngine = ExerciseEngine()

            var finalReportedPosture = ReportedPosture.unknown
            for frame in testCase.frames {
                let observation = poseEngine.process(try decode(frame))
                finalReportedPosture = exerciseEngine.process(observation).reportedPosture
            }

            let summary = exerciseEngine.summary()
            XCTAssertEqual(
                summary.repetitionCount, testCase.expected.repetitionCount, name
            )
            XCTAssertEqual(
                finalReportedPosture.rawValue,
                testCase.expected.finalReportedPosture,
                name
            )
            XCTAssertEqual(
                summary.repetitions.count, testCase.expected.repetitions.count, name
            )

            for (actual, expected) in zip(summary.repetitions, testCase.expected.repetitions) {
                XCTAssertEqual(actual.index, expected.index, name)
                XCTAssertEqual(actual.startMs, expected.startMs, accuracy: tolerance, name)
                XCTAssertEqual(actual.endMs, expected.endMs, accuracy: tolerance, name)
                XCTAssertEqual(
                    actual.durationMs, expected.durationMs, accuracy: tolerance, name
                )
                XCTAssertEqual(
                    actual.minElevation, expected.minElevation, accuracy: tolerance, name
                )
                XCTAssertEqual(actual.depth, expected.depth, accuracy: tolerance, name)
                XCTAssertEqual(
                    actual.formEvents.map(\.rawValue), expected.formEvents, name
                )
            }
        }
    }

    // MARK: - Engine invariants

    func testResetMakesReplayReproducible() throws {
        let testCase = try loadVector(ExerciseCase.self, named: "three-squats", in: "exercise")
        var engine = PoseEngine()
        let first = try testCase.frames.map { engine.process(try decode($0)).hipElevation }
        engine.reset()
        let second = try testCase.frames.map { engine.process(try decode($0)).hipElevation }
        XCTAssertEqual(first, second)
    }

    func testStaleGapDropsCommittedPosture() throws {
        let testCase = try loadVector(ExerciseCase.self, named: "three-squats", in: "exercise")
        var poseEngine = PoseEngine()
        var exerciseEngine = ExerciseEngine()
        let frames = Array(testCase.frames.prefix(40))
        for frame in frames {
            _ = exerciseEngine.process(poseEngine.process(try decode(frame)))
        }

        // A gap longer than the stale threshold must drop the committed posture
        // rather than carrying a stale claim across the interruption.
        let last = try XCTUnwrap(frames.last)
        var resumedFrame = try decode(last)
        resumedFrame.timestampMs = last.t + 5_000
        let resumed = exerciseEngine.process(poseEngine.process(resumedFrame))
        XCTAssertEqual(resumed.reportedPosture, .unknown)
    }

    func testPartialSquatNeverCompletesARepetition() throws {
        let testCase = try loadVector(
            ExerciseCase.self,
            named: "partial-squat-no-depth",
            in: "exercise"
        )
        var poseEngine = PoseEngine()
        var exerciseEngine = ExerciseEngine()
        for frame in testCase.frames {
            let result = exerciseEngine.process(poseEngine.process(try decode(frame)))
            XCTAssertNil(result.completedRepetition)
        }
    }
}

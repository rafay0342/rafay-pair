import XCTest

@testable import RafayPair

/// Cross-platform physiology parity tests.
///
/// These read the same JSON vectors that the TypeScript and Kotlin engines
/// read. A failure here means the Swift engine has diverged from the
/// specifications in `engines/`.
final class PhysiologyGoldenTests: XCTestCase {
    private let tolerance = 1e-6

    // MARK: - Vector decoding

    private struct QualityVector: Decodable {
        let score: Double
        let band: String
        let coverage: Double
        let motion: Double
        let periodicity: Double
        let amplitude: Double
        let stability: Double
    }

    private struct PulseExpectation: Decodable {
        let status: String
        let reason: String?
        let bpm: Double?
        let durationMs: Double
        let sampleCount: Int
        let effectiveSampleRateHz: Double?
        let confidence: Double?
        let confidenceBand: String?
        let source: String?
        let kind: String?
        let quality: QualityVector
    }

    private struct PulseVector: Decodable {
        let name: String
        let measuredAtMs: Double
        let samples: [[Double]]
        let expected: PulseExpectation
    }

    private struct BreathingExpectation: Decodable {
        let status: String
        let reason: String?
        let breathsPerMinute: Double?
        let durationMs: Double
        let sampleCount: Int
        let confidence: Double?
        let confidenceBand: String?
        let source: String?
        let kind: String?
        let quality: QualityVector
    }

    private struct BreathingVector: Decodable {
        let name: String
        let measuredAtMs: Double
        let samples: [[Double]]
        let expected: BreathingExpectation
    }

    private struct CalorieBandVector: Decodable {
        let lowKcal: Double
        let highKcal: Double
        let label: String
    }

    private struct CalorieExpectation: Decodable {
        let estimatedKcal: Double
        let algorithmVersion: String
        let met: Double
        let bodyMassKg: Double
        let repetitions: Int
        let inputsUsed: [String]
        let confidenceBand: CalorieBandVector
    }

    private struct CalorieInputVector: Decodable {
        let activity: String
        let durationMs: Double
        let repetitions: Int?
        let bodyMassKg: Double?
        let poseConfidence: Double?
    }

    private struct CalorieCase: Decodable {
        let name: String
        let input: CalorieInputVector
        let expected: CalorieExpectation
    }

    private struct CalorieVectors: Decodable {
        let cases: [CalorieCase]
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

    private func assertQuality(
        _ actual: SignalQuality,
        _ expected: QualityVector,
        _ label: String
    ) {
        XCTAssertEqual(actual.band.rawValue, expected.band, label)
        XCTAssertEqual(actual.score, expected.score, accuracy: tolerance, label)
        XCTAssertEqual(actual.coverage, expected.coverage, accuracy: tolerance, label)
        XCTAssertEqual(actual.motion, expected.motion, accuracy: tolerance, label)
        XCTAssertEqual(
            actual.periodicity, expected.periodicity, accuracy: tolerance, label
        )
        XCTAssertEqual(actual.amplitude, expected.amplitude, accuracy: tolerance, label)
        XCTAssertEqual(actual.stability, expected.stability, accuracy: tolerance, label)
    }

    // MARK: - Pulse

    private static let pulseVectors = [
        "clean-58bpm",
        "clean-72bpm",
        "finger-lifted",
        "low-perfusion-88bpm",
        "no-pulsation",
        "post-exercise-124bpm",
        "short-session",
        "sliding-finger",
    ]

    func testPulseVectors() throws {
        for name in Self.pulseVectors {
            let vector = try loadVector(PulseVector.self, named: name, in: "pulse")
            let samples = vector.samples.map {
                PulseSample(timestampMs: $0[0], red: $0[1], green: $0[2])
            }
            let actual = PulseEstimator.estimate(samples, measuredAtMs: vector.measuredAtMs)

            XCTAssertEqual(actual.statusName, vector.expected.status, name)
            XCTAssertEqual(actual.sampleCount, vector.expected.sampleCount, name)
            XCTAssertEqual(
                actual.durationMs, vector.expected.durationMs, accuracy: tolerance, name
            )
            assertQuality(actual.quality, vector.expected.quality, name)

            switch actual {
            case .measured(let pulse):
                XCTAssertEqual(
                    pulse.bpm, try XCTUnwrap(vector.expected.bpm), accuracy: tolerance, name
                )
                XCTAssertEqual(
                    pulse.confidence, try XCTUnwrap(vector.expected.confidence),
                    accuracy: tolerance, name
                )
                XCTAssertEqual(
                    pulse.confidenceBand.rawValue, vector.expected.confidenceBand, name
                )
                XCTAssertEqual(
                    pulse.effectiveSampleRateHz,
                    try XCTUnwrap(vector.expected.effectiveSampleRateHz),
                    accuracy: tolerance, name
                )
                // Provenance is structural; there is no case that could carry a
                // measured-grade reading.
                XCTAssertEqual(pulse.source, "phone_camera_ppg", name)
                XCTAssertEqual(pulse.kind, "app_estimated", name)
            case .rejected(let reason, _, _, _):
                XCTAssertEqual(reason.rawValue, vector.expected.reason, name)
            }
        }
    }

    func testPulseRecoversTheSynthesisedRateNotASubharmonic() throws {
        // The octave error is the failure mode that would fabricate a plausible
        // number, so the truth is asserted rather than mere self-consistency.
        let truths: [(String, Double)] = [
            ("clean-72bpm", 72), ("clean-58bpm", 58),
            ("post-exercise-124bpm", 124), ("low-perfusion-88bpm", 88),
        ]
        for (name, truth) in truths {
            let vector = try loadVector(PulseVector.self, named: name, in: "pulse")
            let samples = vector.samples.map {
                PulseSample(timestampMs: $0[0], red: $0[1], green: $0[2])
            }
            guard
                case .measured(let pulse) = PulseEstimator.estimate(
                    samples, measuredAtMs: vector.measuredAtMs
                )
            else {
                XCTFail("\(name) should be measurable")
                continue
            }
            XCTAssertLessThan(abs(pulse.bpm - truth), 2, name)
        }
    }

    // MARK: - Breathing

    private static let breathingVectors = [
        "calm-12-breaths",
        "elevated-20-breaths",
        "fidgeting-but-recoverable",
        "gross-body-movement",
        "poorly-tracked",
        "session-too-short",
        "slow-8-breaths",
    ]

    func testBreathingVectors() throws {
        for name in Self.breathingVectors {
            let vector = try loadVector(BreathingVector.self, named: name, in: "breathing")
            let samples = vector.samples.map {
                BreathingSample(timestampMs: $0[0], chestOffset: $0[1], tracked: $0[2] == 1)
            }
            let actual = BreathingEstimator.estimate(
                samples, measuredAtMs: vector.measuredAtMs
            )

            XCTAssertEqual(actual.statusName, vector.expected.status, name)
            XCTAssertEqual(actual.sampleCount, vector.expected.sampleCount, name)
            assertQuality(actual.quality, vector.expected.quality, name)

            switch actual {
            case .measured(let breathing):
                XCTAssertEqual(
                    breathing.breathsPerMinute,
                    try XCTUnwrap(vector.expected.breathsPerMinute),
                    accuracy: tolerance, name
                )
                XCTAssertEqual(
                    breathing.confidenceBand.rawValue, vector.expected.confidenceBand, name
                )
                XCTAssertEqual(breathing.source, "phone_camera_motion", name)
                XCTAssertEqual(breathing.kind, "app_estimated", name)
            case .rejected(let reason, _, _, _):
                XCTAssertEqual(reason.rawValue, vector.expected.reason, name)
            }
        }
    }

    // MARK: - Calories

    func testCalorieVectors() throws {
        let vectors = try loadVector(CalorieVectors.self, named: "estimates", in: "calories")
        XCTAssertFalse(vectors.cases.isEmpty)

        for testCase in vectors.cases {
            let activity = try XCTUnwrap(
                CalorieActivity(rawValue: testCase.input.activity), testCase.name
            )
            let actual = CalorieEstimator.estimate(
                CalorieEstimateInput(
                    activity: activity,
                    durationMs: testCase.input.durationMs,
                    repetitions: testCase.input.repetitions,
                    bodyMassKg: testCase.input.bodyMassKg,
                    poseConfidence: testCase.input.poseConfidence
                )
            )
            let expected = testCase.expected

            XCTAssertEqual(
                actual.estimatedKcal, expected.estimatedKcal, accuracy: tolerance,
                testCase.name
            )
            XCTAssertEqual(actual.met, expected.met, accuracy: tolerance, testCase.name)
            XCTAssertEqual(
                actual.bodyMassKg, expected.bodyMassKg, accuracy: tolerance, testCase.name
            )
            XCTAssertEqual(actual.repetitions, expected.repetitions, testCase.name)
            XCTAssertEqual(actual.algorithmVersion, expected.algorithmVersion, testCase.name)
            XCTAssertEqual(
                actual.inputsUsed.map(\.rawValue), expected.inputsUsed, testCase.name
            )
            XCTAssertEqual(
                actual.bandLabel.rawValue, expected.confidenceBand.label, testCase.name
            )
            XCTAssertEqual(
                actual.lowKcal, expected.confidenceBand.lowKcal, accuracy: tolerance,
                testCase.name
            )
            XCTAssertEqual(
                actual.highKcal, expected.confidenceBand.highKcal, accuracy: tolerance,
                testCase.name
            )
        }
    }

    // MARK: - Microphone breathing

    private struct AudioFrameVector: Decodable {
        let name: String
        let sampleRateHz: Int
        let pcm: [Double]
        let expectedHops: [[Double]]
    }

    private struct AudioExpectation: Decodable {
        let status: String
        let reason: String?
        let breathsPerMinute: Double?
        let durationMs: Double
        let hopCount: Int
        let confidence: Double?
        let confidenceBand: String?
        let quality: QualityVector
    }

    private struct AudioSessionVector: Decodable {
        let name: String
        let measuredAtMs: Double
        let hops: [[Double]]
        let expected: AudioExpectation
    }

    private static let audioFrameVectors = ["clipped-input", "steady-breathing"]
    private static let audioSessionVectors = [
        "calm-11-breaths",
        "elevated-18-breaths",
        "session-too-short",
        "silent-room",
        "voiced-speech-intrusion",
    ]

    func testMicrophoneFeatureExtraction() throws {
        for name in Self.audioFrameVectors {
            let vector = try loadVector(
                AudioFrameVector.self, named: name, in: "breathing-audio/frames"
            )
            // The vector stores PCM as 16-bit integers, which is what a device
            // delivers; the extractor takes floats in -1...1.
            let samples = vector.pcm.map { $0 / 32_767 }
            let hops = AudioBreathingEstimator.extractHops(samples, startTimestampMs: 0)

            XCTAssertEqual(hops.count, vector.expectedHops.count, name)
            for (index, hop) in hops.enumerated() {
                let expected = vector.expectedHops[index]
                XCTAssertEqual(hop.timestampMs, expected[0], accuracy: tolerance, name)
                XCTAssertEqual(hop.rms, expected[1], accuracy: tolerance, name)
                XCTAssertEqual(
                    hop.zeroCrossingRate, expected[2], accuracy: tolerance, name
                )
                XCTAssertEqual(hop.peak, expected[3], accuracy: tolerance, name)
            }
        }
    }

    func testClippedRecordingHasNoUsableHops() throws {
        let vector = try loadVector(
            AudioFrameVector.self, named: "clipped-input", in: "breathing-audio/frames"
        )
        let hops = vector.expectedHops.map {
            AudioHopFeature(timestampMs: $0[0], rms: $0[1], zeroCrossingRate: $0[2], peak: $0[3])
        }
        XCTAssertFalse(hops.isEmpty)
        XCTAssertTrue(hops.allSatisfy { !AudioBreathingEstimator.isHopUsable($0) })
    }

    func testMicrophoneBreathingVectors() throws {
        for name in Self.audioSessionVectors {
            let vector = try loadVector(
                AudioSessionVector.self, named: name, in: "breathing-audio"
            )
            let hops = vector.hops.map {
                AudioHopFeature(
                    timestampMs: $0[0], rms: $0[1], zeroCrossingRate: $0[2], peak: $0[3]
                )
            }
            let actual = AudioBreathingEstimator.estimate(
                hops, measuredAtMs: vector.measuredAtMs
            )

            XCTAssertEqual(actual.statusName, vector.expected.status, name)
            XCTAssertEqual(actual.hopCount, vector.expected.hopCount, name)
            assertQuality(actual.quality, vector.expected.quality, name)

            switch actual {
            case .measured(let breathing):
                XCTAssertEqual(
                    breathing.breathsPerMinute,
                    try XCTUnwrap(vector.expected.breathsPerMinute),
                    accuracy: tolerance, name
                )
                XCTAssertEqual(
                    breathing.confidenceBand.rawValue, vector.expected.confidenceBand, name
                )
                XCTAssertEqual(breathing.source, "phone_microphone", name)
                XCTAssertEqual(breathing.kind, "app_estimated", name)
            case .rejected(let reason, _, _, _):
                XCTAssertEqual(reason.rawValue, vector.expected.reason, name)
            }
        }
    }

    func testMicrophoneRecoversTheCycleNotTheBurstRate() throws {
        // Breath sound is loud on the inhale and again on the exhale, so a naive
        // peak search reports double. This is the assertion that catches it.
        for (name, truth) in [("calm-11-breaths", 11.0), ("elevated-18-breaths", 18.0)] {
            let vector = try loadVector(
                AudioSessionVector.self, named: name, in: "breathing-audio"
            )
            let hops = vector.hops.map {
                AudioHopFeature(
                    timestampMs: $0[0], rms: $0[1], zeroCrossingRate: $0[2], peak: $0[3]
                )
            }
            guard
                case .measured(let breathing) = AudioBreathingEstimator.estimate(
                    hops, measuredAtMs: vector.measuredAtMs
                )
            else {
                XCTFail("\(name) should be measurable")
                continue
            }
            XCTAssertLessThan(abs(breathing.breathsPerMinute - truth), 1, name)
        }
    }

    // MARK: - Guided breathing and freshness

    func testGuidedBreathingSchedule() {
        let calm = BreathingPattern.calm(cycles: 3)
        // Calm has no hold phases, so they must be skipped rather than reported.
        XCTAssertEqual(BreathingEstimator.phase(of: calm, elapsedMs: 0).phase, .inhale)
        XCTAssertEqual(BreathingEstimator.phase(of: calm, elapsedMs: 3_999).phase, .inhale)
        XCTAssertEqual(BreathingEstimator.phase(of: calm, elapsedMs: 4_000).phase, .exhale)
        XCTAssertEqual(BreathingEstimator.phase(of: calm, elapsedMs: 10_000).cycleIndex, 1)
        XCTAssertEqual(BreathingEstimator.phase(of: calm, elapsedMs: 30_000).phase, .complete)

        let box = BreathingPattern.box(cycles: 1)
        XCTAssertEqual(BreathingEstimator.phase(of: box, elapsedMs: 6_000).phase, .hold)
        XCTAssertEqual(BreathingEstimator.phase(of: box, elapsedMs: 10_000).phase, .exhale)
        XCTAssertEqual(BreathingEstimator.phase(of: box, elapsedMs: 14_000).phase, .holdAfter)
        XCTAssertEqual(
            BreathingEstimator.phase(of: box, elapsedMs: 2_000).progress, 0.5,
            accuracy: tolerance
        )
    }

    func testPulseFreshnessExpiresAtTheWindow() {
        let pulse = MeasuredPulse(
            bpm: 72,
            durationMs: 20_000,
            sampleCount: 600,
            effectiveSampleRateHz: 30,
            quality: .empty,
            confidence: 0.9,
            confidenceBand: .high,
            measuredAtMs: 1_000_000
        )
        XCTAssertTrue(PulseFreshness.isFresh(pulse, now: 1_000_000))
        XCTAssertTrue(
            PulseFreshness.isFresh(
                pulse, now: 1_000_000 + PhysiologyTuning.pulseFreshnessMs - 1
            )
        )
        // Master specification §4: an expired reading stops being current
        // everywhere, including for a partner.
        XCTAssertFalse(
            PulseFreshness.isFresh(pulse, now: 1_000_000 + PhysiologyTuning.pulseFreshnessMs)
        )
        XCTAssertEqual(PulseFreshness.ageMs(pulse, now: 999_000), 0)
    }
}

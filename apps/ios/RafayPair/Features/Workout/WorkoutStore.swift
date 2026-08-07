import Foundation

/// Drives the pose and exercise engines from captured frames and exposes the
/// state a local workout screen needs.
///
/// Everything here is on-device. No landmark, frame, or summary is transmitted;
/// sharing a summary with a partner is a separate, consent-gated action.
@MainActor
@Observable
final class WorkoutStore {
    private(set) var reportedPosture: ReportedPosture = .unknown
    private(set) var repetitionCount = 0
    private(set) var framingOk = true
    private(set) var tracking = false
    private(set) var lastRepetition: Repetition?
    private(set) var summary: SessionSummary?
    private(set) var calories: CalorieEstimate?
    private(set) var isRecording = false

    private var poseEngine = PoseEngine()
    private var exerciseEngine = ExerciseEngine()

    var guidance: String {
        if !isRecording { return "Start a session when you are ready." }
        if !tracking { return "Step into view so your whole body is visible." }
        if !framingOk { return "Move back a little — your feet are outside the frame." }
        switch reportedPosture {
        case .unknown: return "Hold still for a moment while tracking settles."
        case .standing: return "Standing. Lower into a squat when you are ready."
        case .squatting: return "Squatting — keep your chest lifted."
        case .sitting: return "Sitting."
        case .lyingDown: return "Lying down."
        }
    }

    func startSession() {
        poseEngine.reset()
        exerciseEngine.reset()
        reportedPosture = .unknown
        repetitionCount = 0
        lastRepetition = nil
        summary = nil
        calories = nil
        tracking = false
        isRecording = true
    }

    func endSession() {
        guard isRecording else { return }
        isRecording = false
        let session = exerciseEngine.summary()
        summary = session
        // Body mass is only supplied when the user has chosen to give it, and
        // its absence widens the band rather than being guessed at.
        calories = CalorieEstimator.estimate(
            CalorieEstimateInput(
                activity: .squat,
                durationMs: session.endedAtMs - session.startedAtMs,
                repetitions: session.repetitionCount,
                bodyMassKg: nil,
                poseConfidence: nil
            )
        )
    }

    func handle(frame: PoseFrame) {
        guard isRecording else { return }
        let observation = poseEngine.process(frame)
        tracking = observation.valid
        framingOk = observation.framingOk

        let result = exerciseEngine.process(observation)
        reportedPosture = result.reportedPosture
        repetitionCount = result.repetitionCount
        if let completed = result.completedRepetition {
            lastRepetition = completed
        }
    }
}

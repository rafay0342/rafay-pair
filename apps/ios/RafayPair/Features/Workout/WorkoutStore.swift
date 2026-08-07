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
    /// Set only while an accepted together session is open on this account.
    private(set) var sharingWithPartner = false

    private var poseEngine = PoseEngine()
    private var exerciseEngine = ExerciseEngine()

    /// Absent in previews and tests. When present, and only while an accepted
    /// together session is open, the counts this engine derives are published to
    /// the partner. The engine's inputs never leave the device.
    private let together: (any TogetherRepository)?
    private var openSessionId: UUID?
    private var publishTask: Task<Void, Never>?
    private var startedAtMs: Double = 0

    init(together: (any TogetherRepository)? = nil) {
        self.together = together
    }

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
        startedAtMs = Date().timeIntervalSince1970 * 1000
        startPublishing()
    }

    func endSession() {
        guard isRecording else { return }
        isRecording = false
        publishTask?.cancel()
        publishTask = nil
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
        // A final publish so the partner's screen settles on the real total
        // rather than on whichever tick happened to land last.
        Task { await publishOnce(finished: true) }
    }

    /// Publishes derived state on a fixed cadence rather than on every frame.
    /// Per-frame publishing would put the pose sampling rate itself on the wire,
    /// which is a detail of what the camera saw.
    private func startPublishing() {
        guard let together else { return }
        publishTask?.cancel()
        publishTask = Task { [weak self] in
            guard let session = try? await together.current(), session.status == .active else {
                return
            }
            guard let self else { return }
            self.openSessionId = session.id
            self.sharingWithPartner = true
            while !Task.isCancelled, self.isRecording {
                await self.publishOnce(finished: false)
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private func publishOnce(finished: Bool) async {
        guard let together, let sessionId = openSessionId else { return }
        let elapsed = max(0, Date().timeIntervalSince1970 * 1000 - startedAtMs)
        let updated = try? await together.publish(
            id: sessionId,
            state: PublishTogetherStateRequest(
                repetitions: repetitionCount,
                exercisePhase: finished ? .complete : phase(for: reportedPosture),
                setIndex: 0,
                elapsedMs: Int(elapsed),
                estimatedKcal: calories?.estimatedKcal,
                breathingState: nil
            )
        )
        guard finished || updated == nil else { return }
        openSessionId = (updated?.status == .active) ? updated?.id : nil
        if openSessionId == nil { sharingWithPartner = false }
    }

    /// Only what the posture classifier actually reports. There is no
    /// `ascending`: the engine does not distinguish it, so claiming it would be
    /// inventing a phase.
    private func phase(for posture: ReportedPosture) -> TogetherExercisePhase {
        switch posture {
        case .unknown: .idle
        case .squatting: .bottom
        case .standing, .sitting, .lyingDown: .resting
        }
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

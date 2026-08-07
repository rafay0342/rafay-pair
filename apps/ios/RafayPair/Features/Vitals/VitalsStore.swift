import Foundation
import Observation

/// Drives the pulse measurement session, the heart visualization's freshness,
/// and guided breathing.
///
/// Everything here is on-device. A result reaches a partner only through an
/// explicit, consent-gated share.
@MainActor
@Observable
final class VitalsStore {
    enum Phase: Equatable {
        case idle
        case measuring
        case finished
    }

    private(set) var phase: Phase = .idle
    private(set) var latestPulse: MeasuredPulse?
    private(set) var lastRejection: PulseRejectionReason?
    private(set) var breathingPattern = BreathingPattern.calm(cycles: 6)
    private(set) var breathingStartedAt: Date?
    private(set) var breathingEstimate: MeasuredAudioBreathing?
    private(set) var breathingRejection: AudioBreathingRejectionReason?
    /// Off by default: listening is opt-in even inside a session the user
    /// already started, because a microphone is a distinct expectation from a
    /// paced animation.
    var listenForBreathing = false

    /// Master specification §6B, behind `camera_breathing_estimate`. Offered
    /// only when the experiment is on; the control does not exist otherwise,
    /// because a disabled switch would still be an announcement.
    private(set) var cameraBreathingOffered = false
    var watchForBreathing = false
    private(set) var chestVisible = false
    private(set) var cameraBreathingEstimate: MeasuredBreathing?
    private(set) var cameraBreathingRejection: BreathingRejectionReason?
    private var chestSamples: [BreathingSample] = []

    var isWatching: Bool { cameraBreathingOffered && watchForBreathing && breathingStartedAt != nil }

    func offerCameraBreathing(_ offered: Bool) {
        cameraBreathingOffered = offered
        if !offered { watchForBreathing = false }
    }

    /// Recomputed from a timer tick so an expired reading stops presenting
    /// itself as current, per master specification §4.
    var now: Date = .now

    var pulseIsFresh: Bool {
        guard let latestPulse else { return false }
        return PulseFreshness.isFresh(latestPulse, now: now.timeIntervalSince1970 * 1000)
    }

    var pulseAgeSeconds: Int {
        guard let latestPulse else { return 0 }
        return Int(
            PulseFreshness.ageMs(latestPulse, now: now.timeIntervalSince1970 * 1000) / 1000
        )
    }

    /// The rate the heart orb animates at, or `nil` when there is nothing
    /// current to animate. A stale reading is never animated as if live.
    var animatedBpm: Double? {
        pulseIsFresh ? latestPulse?.bpm : nil
    }

    var breathingPhase: BreathingPhaseState? {
        guard let breathingStartedAt else { return nil }
        let elapsed = now.timeIntervalSince(breathingStartedAt) * 1000
        return BreathingEstimator.phase(of: breathingPattern, elapsedMs: elapsed)
    }

    func beginMeasurement() {
        phase = .measuring
        lastRejection = nil
    }

    /// Scores the collected session. A rejection replaces nothing: the previous
    /// reading keeps its own timestamp and freshness rather than being refreshed
    /// by a failed attempt.
    func finishMeasurement(samples: [PulseSample]) {
        phase = .finished
        let result = PulseEstimator.estimate(
            samples, measuredAtMs: Date().timeIntervalSince1970 * 1000
        )
        switch result {
        case .measured(let pulse):
            latestPulse = pulse
            lastRejection = nil
        case .rejected(let reason, _, _, _):
            lastRejection = reason
        }
    }

    func cancelMeasurement() {
        phase = .idle
    }

    func startBreathing(_ pattern: BreathingPattern) {
        breathingPattern = pattern
        breathingStartedAt = .now
        breathingEstimate = nil
        breathingRejection = nil
        chestSamples = []
        chestVisible = false
        cameraBreathingEstimate = nil
        cameraBreathingRejection = nil
    }

    /// Turns one pose frame into one breathing sample and releases the frame.
    ///
    /// The landmarks are reduced here, in the callback: nothing retains a frame,
    /// and the estimator's input carries a single scalar per sample.
    func handleBreathingFrame(_ frame: PoseFrame) {
        guard isWatching else { return }
        let sample = ChestSample.from(
            timestampMs: frame.timestampMs,
            leftShoulder: frame.joint(.leftShoulder).chestPoint,
            rightShoulder: frame.joint(.rightShoulder).chestPoint,
            leftHip: frame.joint(.leftHip).chestPoint,
            rightHip: frame.joint(.rightHip).chestPoint
        )
        chestSamples.append(sample)
        chestVisible = sample.tracked
    }

    /// Scores a finished watching session. A rejection replaces nothing.
    func finishWatching() {
        let collected = chestSamples
        chestSamples = []
        chestVisible = false
        guard !collected.isEmpty else { return }

        switch BreathingEstimator.estimate(
            collected, measuredAtMs: Date().timeIntervalSince1970 * 1000
        ) {
        case .measured(let breathing):
            cameraBreathingEstimate = breathing
            cameraBreathingRejection = nil
        case .rejected(let reason, _, _, _):
            cameraBreathingRejection = reason
        }
    }

    func cameraGuidance(for reason: BreathingRejectionReason) -> String {
        switch reason {
        case .tooShort:
            "Watching needs about half a minute of steady breathing to say anything."
        case .notTracked:
            "Your torso was not in view for enough of the session."
        case .excessiveMotion:
            "There was too much movement to read breathing from chest motion."
        case .noPeriodicity:
            "No steady rhythm came through."
        case .unstable:
            "The rhythm kept changing, so no single rate would be honest."
        case .outOfRange:
            "The result was outside a plausible range, so it was discarded."
        }
    }

    func stopBreathing() {
        breathingStartedAt = nil
    }

    /// Scores a finished listening session. A rejection replaces nothing.
    func finishListening(hops: [AudioHopFeature]) {
        let result = AudioBreathingEstimator.estimate(
            hops, measuredAtMs: Date().timeIntervalSince1970 * 1000
        )
        switch result {
        case .measured(let breathing):
            breathingEstimate = breathing
            breathingRejection = nil
        case .rejected(let reason, _, _, _):
            breathingRejection = reason
        }
    }

    func guidance(for reason: AudioBreathingRejectionReason) -> String {
        switch reason {
        case .tooShort:
            "Listening needs about twenty seconds of breathing to say anything."
        case .notAudible:
            "Too quiet to hear. Try holding the phone a little closer."
        case .tooNoisy:
            "There was too much background sound to pick out breathing."
        case .noPeriodicity:
            "No steady rhythm came through."
        case .unstable:
            "The rhythm kept changing, so no single rate would be honest."
        case .outOfRange:
            "The result was outside a plausible range, so it was discarded."
        }
    }

    func guidance(for reason: PulseRejectionReason) -> String {
        switch reason {
        case .tooShort:
            "Hold still a little longer — measuring needs about twenty seconds."
        case .fingerNotDetected:
            "Cover the rear camera and the torch completely with your fingertip."
        case .excessiveMotion:
            "Rest your hand on something steady and try again."
        case .noPeriodicity:
            "No steady pulse came through. Press gently, without squeezing."
        case .unstable:
            "The reading kept drifting. Try again while staying still."
        case .outOfRange:
            "The result was outside a plausible range, so it was discarded."
        }
    }
}

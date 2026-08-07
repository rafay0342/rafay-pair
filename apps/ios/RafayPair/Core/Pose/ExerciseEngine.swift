import Foundation

/// Temporal exercise engine — the Swift implementation of
/// `engines/exercise-state-machines/SPEC.md`.
///
/// Owns every claim a single frame cannot support: sitting versus a squat
/// bottom, committed postures, and repetition counting.
struct ExerciseEngine: Sendable {
    private struct ElevationSample {
        var timestampMs: Double
        var elevation: Double
    }

    private struct Candidate {
        var posture: Posture
        var sinceMs: Double
        /// Trailing `sitHoldMs` of hip elevations. Stability is judged over
        /// this window rather than the whole run, because the run necessarily
        /// begins part-way through the descent and including that descent would
        /// hold the spread permanently outside the band.
        var window: [ElevationSample]
    }

    private var committed: ReportedPosture = .unknown
    private var candidate: Candidate?

    private var phase: SquatPhase = .idle
    private var wasAtTop = false
    private var cycleStartMs: Double = 0
    private var minElevation = Double.infinity
    private var deepest: PoseObservation?

    private var repetitions: [Repetition] = []
    private var lastValidMs: Double?
    private var previousFrameMs: Double?
    private var previousReported: ReportedPosture = .unknown
    private var startedAtMs: Double?
    private var endedAtMs: Double = 0
    private var timeline: [ReportedPosture: Double] = [:]

    init() {}

    mutating func reset() {
        committed = .unknown
        candidate = nil
        abandonRepetition()
        wasAtTop = false
        repetitions.removeAll()
        lastValidMs = nil
        previousFrameMs = nil
        previousReported = .unknown
        startedAtMs = nil
        endedAtMs = 0
        timeline.removeAll()
    }

    mutating func process(_ observation: PoseObservation) -> ExerciseObservation {
        let now = observation.timestampMs
        if startedAtMs == nil { startedAtMs = now }
        endedAtMs = now

        // Attribute the elapsed interval to whatever we were reporting during
        // it, before this frame can change the answer.
        if let previous = previousFrameMs, now > previous {
            timeline[previousReported, default: 0] += now - previous
        }
        previousFrameMs = now

        if let lastValid = lastValidMs, now - lastValid > PoseTuning.staleFrameMs {
            committed = .unknown
            candidate = nil
            abandonRepetition()
            wasAtTop = false
        }

        var completed: Repetition?
        if observation.valid {
            lastValidMs = now
            trackCandidate(observation)
            if promoteCandidate(now: now) {
                // Standing up from a chair, or rising from the floor, is not a
                // squat. Settling into a resting posture discards any partial
                // cycle and requires a fresh trip to the top.
                abandonRepetition()
                wasAtTop = false
            } else {
                completed = advanceSquat(observation)
            }
        }

        let reported = reportedPosture()
        previousReported = reported

        return ExerciseObservation(
            timestampMs: now,
            reportedPosture: reported,
            squatPhase: phase,
            repetitionCount: repetitions.count,
            completedRepetition: completed
        )
    }

    func summary() -> SessionSummary {
        var formEventCounts: [FormEvent: Int] = [:]
        var bestDepth = 0.0
        var totalDuration = 0.0
        for repetition in repetitions {
            if repetition.depth > bestDepth { bestDepth = repetition.depth }
            totalDuration += repetition.durationMs
            for event in repetition.formEvents {
                formEventCounts[event, default: 0] += 1
            }
        }
        return SessionSummary(
            startedAtMs: startedAtMs ?? 0,
            endedAtMs: endedAtMs,
            repetitions: repetitions,
            repetitionCount: repetitions.count,
            bestDepth: bestDepth,
            averageDurationMs: repetitions.isEmpty
                ? 0
                : totalDuration / Double(repetitions.count),
            postureTimelineMs: timeline,
            formEventCounts: formEventCounts
        )
    }

    /// Tracks the run of consecutive frames sharing a static posture.
    private mutating func trackCandidate(_ observation: PoseObservation) {
        let sample = ElevationSample(
            timestampMs: observation.timestampMs,
            elevation: observation.hipElevation
        )
        guard var current = candidate, current.posture == observation.posture else {
            candidate = Candidate(
                posture: observation.posture,
                sinceMs: observation.timestampMs,
                window: [sample]
            )
            return
        }
        current.window.append(sample)
        let cutoff = observation.timestampMs - PoseTuning.sitHoldMs
        var drop = 0
        while drop < current.window.count - 1,
            current.window[drop].timestampMs < cutoff
        {
            drop += 1
        }
        if drop > 0 { current.window.removeFirst(drop) }
        candidate = current
    }

    /// Promotes a held candidate to the committed posture. Returns `true` when
    /// the subject has just settled into a resting posture, which cancels any
    /// squat repetition in flight.
    private mutating func promoteCandidate(now: Double) -> Bool {
        guard let candidate else { return false }
        let held = now - candidate.sinceMs

        if candidate.posture == .standing, held >= PoseTuning.standHoldMs {
            committed = .standing
            return false
        }
        if candidate.posture == .lying, held >= PoseTuning.lieHoldMs {
            let wasLying = committed == .lyingDown
            committed = .lyingDown
            return !wasLying
        }
        if candidate.posture == .crouched, held >= PoseTuning.sitHoldMs {
            // A squat pauses briefly at depth and keeps moving; a seated
            // subject holds a steady hip height. Stability separates them.
            var lowest = Double.infinity
            var highest = -Double.infinity
            for sample in candidate.window {
                if sample.elevation < lowest { lowest = sample.elevation }
                if sample.elevation > highest { highest = sample.elevation }
            }
            if highest - lowest <= PoseTuning.sitStabilityBand {
                let wasSitting = committed == .sitting
                committed = .sitting
                return !wasSitting
            }
        }
        return false
    }

    private mutating func advanceSquat(_ observation: PoseObservation) -> Repetition? {
        let elevation = observation.hipElevation
        let now = observation.timestampMs

        switch phase {
        case .idle:
            if elevation >= PoseTuning.squatTopElevation {
                wasAtTop = true
            } else if wasAtTop {
                phase = elevation <= PoseTuning.squatBottomElevation ? .bottom : .descending
                cycleStartMs = now
                minElevation = elevation
                deepest = observation
            }
            return nil

        case .descending:
            trackDepth(observation)
            if elevation <= PoseTuning.squatBottomElevation {
                phase = .bottom
            } else if elevation >= PoseTuning.squatTopElevation {
                abandonRepetition()
                wasAtTop = true
            } else if now - cycleStartMs > PoseTuning.squatMaxCycleMs {
                abandonRepetition()
                wasAtTop = false
            }
            return nil

        case .bottom:
            trackDepth(observation)
            if elevation >= PoseTuning.squatTopElevation {
                let durationMs = now - cycleStartMs
                var repetition: Repetition?
                if durationMs >= PoseTuning.squatMinCycleMs,
                    durationMs <= PoseTuning.squatMaxCycleMs
                {
                    repetition = completeRepetition(now: now, durationMs: durationMs)
                }
                abandonRepetition()
                wasAtTop = true
                return repetition
            }
            if now - cycleStartMs > PoseTuning.squatMaxCycleMs {
                abandonRepetition()
                wasAtTop = false
            }
            return nil
        }
    }

    private mutating func trackDepth(_ observation: PoseObservation) {
        if observation.hipElevation < minElevation {
            minElevation = observation.hipElevation
            deepest = observation
        }
    }

    private mutating func completeRepetition(now: Double, durationMs: Double) -> Repetition {
        var formEvents: [FormEvent] = []
        if minElevation > PoseTuning.squatBottomElevation - PoseTuning.shallowDepthMargin {
            formEvents.append(.shallowDepth)
        }
        if let deepest, deepest.torsoAngleDeg >= PoseTuning.forwardLeanDeg {
            formEvents.append(.forwardLean)
        }
        if let deepest,
            abs(deepest.leftKneeAngle - deepest.rightKneeAngle) >= PoseTuning.unevenKneeDeg
        {
            formEvents.append(.uneven)
        }
        let repetition = Repetition(
            index: repetitions.count + 1,
            startMs: cycleStartMs,
            endMs: now,
            durationMs: durationMs,
            minElevation: minElevation,
            depth: (PoseTuning.squatTopElevation - minElevation) / PoseTuning.squatTopElevation,
            formEvents: formEvents
        )
        repetitions.append(repetition)
        return repetition
    }

    private mutating func abandonRepetition() {
        phase = .idle
        cycleStartMs = 0
        minElevation = .infinity
        deepest = nil
    }

    private func reportedPosture() -> ReportedPosture {
        phase == .idle ? committed : .squatting
    }
}

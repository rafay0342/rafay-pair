package com.rafaypair.android.pose

import kotlin.math.abs

/**
 * Temporal exercise engine — the Kotlin implementation of
 * `engines/exercise-state-machines/SPEC.md`.
 *
 * Owns every claim a single frame cannot support: sitting versus a squat bottom,
 * committed postures, and repetition counting.
 */
class ExerciseEngine {
    private data class ElevationSample(val timestampMs: Double, val elevation: Double)

    private class Candidate(
        val posture: Posture,
        val sinceMs: Double,
        /**
         * Trailing [PoseTuning.SIT_HOLD_MS] of hip elevations. Stability is
         * judged over this window rather than the whole run, because the run
         * necessarily begins part-way through the descent and including that
         * descent would hold the spread permanently outside the band.
         */
        val window: ArrayDeque<ElevationSample>,
    )

    private var committed = ReportedPosture.UNKNOWN
    private var candidate: Candidate? = null

    private var phase = SquatPhase.IDLE
    private var wasAtTop = false
    private var cycleStartMs = 0.0
    private var minElevation = Double.POSITIVE_INFINITY
    private var deepest: PoseObservation? = null

    private val repetitions = mutableListOf<Repetition>()
    private var lastValidMs: Double? = null
    private var previousFrameMs: Double? = null
    private var previousReported = ReportedPosture.UNKNOWN
    private var startedAtMs: Double? = null
    private var endedAtMs = 0.0
    private val timeline = mutableMapOf<ReportedPosture, Double>()

    fun reset() {
        committed = ReportedPosture.UNKNOWN
        candidate = null
        abandonRepetition()
        wasAtTop = false
        repetitions.clear()
        lastValidMs = null
        previousFrameMs = null
        previousReported = ReportedPosture.UNKNOWN
        startedAtMs = null
        endedAtMs = 0.0
        timeline.clear()
    }

    fun process(observation: PoseObservation): ExerciseObservation {
        val now = observation.timestampMs
        if (startedAtMs == null) startedAtMs = now
        endedAtMs = now

        // Attribute the elapsed interval to whatever we were reporting during
        // it, before this frame can change the answer.
        val previous = previousFrameMs
        if (previous != null && now > previous) {
            timeline[previousReported] = (timeline[previousReported] ?: 0.0) + (now - previous)
        }
        previousFrameMs = now

        val lastValid = lastValidMs
        if (lastValid != null && now - lastValid > PoseTuning.STALE_FRAME_MS) {
            committed = ReportedPosture.UNKNOWN
            candidate = null
            abandonRepetition()
            wasAtTop = false
        }

        var completed: Repetition? = null
        if (observation.valid) {
            lastValidMs = now
            trackCandidate(observation)
            if (promoteCandidate(now)) {
                // Standing up from a chair, or rising from the floor, is not a
                // squat. Settling into a resting posture discards any partial
                // cycle and requires a fresh trip to the top.
                abandonRepetition()
                wasAtTop = false
            } else {
                completed = advanceSquat(observation)
            }
        }

        val reported = reportedPosture()
        previousReported = reported

        return ExerciseObservation(
            timestampMs = now,
            reportedPosture = reported,
            squatPhase = phase,
            repetitionCount = repetitions.size,
            completedRepetition = completed,
        )
    }

    fun summary(): SessionSummary {
        val formEventCounts = mutableMapOf<FormEvent, Int>()
        var bestDepth = 0.0
        var totalDuration = 0.0
        for (repetition in repetitions) {
            if (repetition.depth > bestDepth) bestDepth = repetition.depth
            totalDuration += repetition.durationMs
            for (event in repetition.formEvents) {
                formEventCounts[event] = (formEventCounts[event] ?: 0) + 1
            }
        }
        return SessionSummary(
            startedAtMs = startedAtMs ?: 0.0,
            endedAtMs = endedAtMs,
            repetitions = repetitions.toList(),
            repetitionCount = repetitions.size,
            bestDepth = bestDepth,
            averageDurationMs = if (repetitions.isEmpty()) {
                0.0
            } else {
                totalDuration / repetitions.size
            },
            postureTimelineMs = timeline.toMap(),
            formEventCounts = formEventCounts.toMap(),
        )
    }

    /** Tracks the run of consecutive frames sharing a static posture. */
    private fun trackCandidate(observation: PoseObservation) {
        val sample = ElevationSample(observation.timestampMs, observation.hipElevation)
        val current = candidate
        if (current == null || current.posture != observation.posture) {
            candidate = Candidate(
                posture = observation.posture,
                sinceMs = observation.timestampMs,
                window = ArrayDeque(listOf(sample)),
            )
            return
        }
        current.window.addLast(sample)
        val cutoff = observation.timestampMs - PoseTuning.SIT_HOLD_MS
        while (current.window.size > 1 && current.window.first().timestampMs < cutoff) {
            current.window.removeFirst()
        }
    }

    /**
     * Promotes a held candidate to the committed posture. Returns `true` when
     * the subject has just settled into a resting posture, which cancels any
     * squat repetition in flight.
     */
    private fun promoteCandidate(now: Double): Boolean {
        val candidate = candidate ?: return false
        val held = now - candidate.sinceMs

        if (candidate.posture == Posture.STANDING && held >= PoseTuning.STAND_HOLD_MS) {
            committed = ReportedPosture.STANDING
            return false
        }
        if (candidate.posture == Posture.LYING && held >= PoseTuning.LIE_HOLD_MS) {
            val wasLying = committed == ReportedPosture.LYING_DOWN
            committed = ReportedPosture.LYING_DOWN
            return !wasLying
        }
        if (candidate.posture == Posture.CROUCHED && held >= PoseTuning.SIT_HOLD_MS) {
            // A squat pauses briefly at depth and keeps moving; a seated subject
            // holds a steady hip height. Stability separates them.
            var lowest = Double.POSITIVE_INFINITY
            var highest = Double.NEGATIVE_INFINITY
            for (sample in candidate.window) {
                if (sample.elevation < lowest) lowest = sample.elevation
                if (sample.elevation > highest) highest = sample.elevation
            }
            if (highest - lowest <= PoseTuning.SIT_STABILITY_BAND) {
                val wasSitting = committed == ReportedPosture.SITTING
                committed = ReportedPosture.SITTING
                return !wasSitting
            }
        }
        return false
    }

    private fun advanceSquat(observation: PoseObservation): Repetition? {
        val elevation = observation.hipElevation
        val now = observation.timestampMs

        when (phase) {
            SquatPhase.IDLE -> {
                if (elevation >= PoseTuning.SQUAT_TOP_ELEVATION) {
                    wasAtTop = true
                } else if (wasAtTop) {
                    phase = if (elevation <= PoseTuning.SQUAT_BOTTOM_ELEVATION) {
                        SquatPhase.BOTTOM
                    } else {
                        SquatPhase.DESCENDING
                    }
                    cycleStartMs = now
                    minElevation = elevation
                    deepest = observation
                }
                return null
            }

            SquatPhase.DESCENDING -> {
                trackDepth(observation)
                if (elevation <= PoseTuning.SQUAT_BOTTOM_ELEVATION) {
                    phase = SquatPhase.BOTTOM
                } else if (elevation >= PoseTuning.SQUAT_TOP_ELEVATION) {
                    abandonRepetition()
                    wasAtTop = true
                } else if (now - cycleStartMs > PoseTuning.SQUAT_MAX_CYCLE_MS) {
                    abandonRepetition()
                    wasAtTop = false
                }
                return null
            }

            SquatPhase.BOTTOM -> {
                trackDepth(observation)
                if (elevation >= PoseTuning.SQUAT_TOP_ELEVATION) {
                    val durationMs = now - cycleStartMs
                    val repetition = if (
                        durationMs >= PoseTuning.SQUAT_MIN_CYCLE_MS &&
                        durationMs <= PoseTuning.SQUAT_MAX_CYCLE_MS
                    ) {
                        completeRepetition(now, durationMs)
                    } else {
                        null
                    }
                    abandonRepetition()
                    wasAtTop = true
                    return repetition
                }
                if (now - cycleStartMs > PoseTuning.SQUAT_MAX_CYCLE_MS) {
                    abandonRepetition()
                    wasAtTop = false
                }
                return null
            }
        }
    }

    private fun trackDepth(observation: PoseObservation) {
        if (observation.hipElevation < minElevation) {
            minElevation = observation.hipElevation
            deepest = observation
        }
    }

    private fun completeRepetition(now: Double, durationMs: Double): Repetition {
        val deepestObservation = deepest
        val formEvents = mutableListOf<FormEvent>()
        if (minElevation > PoseTuning.SQUAT_BOTTOM_ELEVATION - PoseTuning.SHALLOW_DEPTH_MARGIN) {
            formEvents.add(FormEvent.SHALLOW_DEPTH)
        }
        if (deepestObservation != null &&
            deepestObservation.torsoAngleDeg >= PoseTuning.FORWARD_LEAN_DEG
        ) {
            formEvents.add(FormEvent.FORWARD_LEAN)
        }
        if (deepestObservation != null &&
            abs(deepestObservation.leftKneeAngle - deepestObservation.rightKneeAngle) >=
            PoseTuning.UNEVEN_KNEE_DEG
        ) {
            formEvents.add(FormEvent.UNEVEN)
        }
        val repetition = Repetition(
            index = repetitions.size + 1,
            startMs = cycleStartMs,
            endMs = now,
            durationMs = durationMs,
            minElevation = minElevation,
            depth = (PoseTuning.SQUAT_TOP_ELEVATION - minElevation) /
                PoseTuning.SQUAT_TOP_ELEVATION,
            formEvents = formEvents.toList(),
        )
        repetitions.add(repetition)
        return repetition
    }

    private fun abandonRepetition() {
        phase = SquatPhase.IDLE
        cycleStartMs = 0.0
        minElevation = Double.POSITIVE_INFINITY
        deepest = null
    }

    private fun reportedPosture(): ReportedPosture =
        if (phase == SquatPhase.IDLE) committed else ReportedPosture.SQUATTING
}

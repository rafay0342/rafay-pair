/**
 * Temporal exercise engine — the reference implementation of
 * `engines/exercise-state-machines/SPEC.md`.
 *
 * Consumes `PoseObservation`s in timestamp order and owns every claim that a
 * single frame cannot support: sitting versus a squat bottom, committed
 * postures, and repetition counting.
 */

import {
  FORWARD_LEAN_DEG,
  LIE_HOLD_MS,
  SHALLOW_DEPTH_MARGIN,
  SIT_HOLD_MS,
  SIT_STABILITY_BAND,
  SQUAT_BOTTOM_ELEVATION,
  SQUAT_MAX_CYCLE_MS,
  SQUAT_MIN_CYCLE_MS,
  SQUAT_TOP_ELEVATION,
  STALE_FRAME_MS,
  STAND_HOLD_MS,
  UNEVEN_KNEE_DEG,
} from "./constants.js";
import type {
  ExerciseObservation,
  FormEvent,
  PoseObservation,
  Posture,
  ReportedPosture,
  Repetition,
  SessionSummary,
  SquatPhase,
} from "./types.js";

interface ElevationSample {
  readonly timestampMs: number;
  readonly elevation: number;
}

interface Candidate {
  readonly posture: Posture;
  readonly sinceMs: number;
  /**
   * Trailing `SIT_HOLD_MS` of hip elevations. Stability is judged over this
   * window rather than the whole candidate run: the run necessarily begins
   * part-way through the descent, and including that descent would leave the
   * spread permanently outside the band, so a genuinely seated subject would
   * never settle.
   */
  readonly window: ElevationSample[];
}

const EMPTY_TIMELINE: Record<ReportedPosture, number> = {
  unknown: 0,
  standing: 0,
  sitting: 0,
  lyingDown: 0,
  squatting: 0,
};

const EMPTY_FORM_COUNTS: Record<FormEvent, number> = {
  shallowDepth: 0,
  forwardLean: 0,
  uneven: 0,
};

export class ExerciseEngine {
  private committed: ReportedPosture = "unknown";
  private candidate: Candidate | undefined;

  private phase: SquatPhase = "idle";
  private wasAtTop = false;
  private cycleStartMs = 0;
  private minElevation = Number.POSITIVE_INFINITY;
  private deepest: PoseObservation | undefined;

  private readonly repetitions: Repetition[] = [];
  private lastValidMs: number | undefined;
  private previousFrameMs: number | undefined;
  private previousReported: ReportedPosture = "unknown";
  private startedAtMs: number | undefined;
  private endedAtMs = 0;
  private readonly timeline: Record<ReportedPosture, number> = {
    ...EMPTY_TIMELINE,
  };

  public reset(): void {
    this.committed = "unknown";
    this.candidate = undefined;
    this.abandonRepetition();
    this.wasAtTop = false;
    this.repetitions.length = 0;
    this.lastValidMs = undefined;
    this.previousFrameMs = undefined;
    this.previousReported = "unknown";
    this.startedAtMs = undefined;
    this.endedAtMs = 0;
    for (const key of Object.keys(this.timeline) as ReportedPosture[]) {
      this.timeline[key] = 0;
    }
  }

  public process(observation: PoseObservation): ExerciseObservation {
    const now = observation.timestampMs;
    this.startedAtMs ??= now;
    this.endedAtMs = now;

    // Attribute the elapsed interval to whatever we were reporting during it,
    // before this frame can change the answer.
    if (this.previousFrameMs !== undefined && now > this.previousFrameMs) {
      this.timeline[this.previousReported] += now - this.previousFrameMs;
    }
    this.previousFrameMs = now;

    if (
      this.lastValidMs !== undefined &&
      now - this.lastValidMs > STALE_FRAME_MS
    ) {
      this.committed = "unknown";
      this.candidate = undefined;
      this.abandonRepetition();
      this.wasAtTop = false;
    }

    let completed: Repetition | undefined;
    if (observation.valid) {
      this.lastValidMs = now;
      this.trackCandidate(observation);
      const settled = this.promoteCandidate(now);
      if (settled) {
        // Standing up from a chair, or rising from the floor, is not a squat.
        // Settling into sitting or lying discards any partial cycle and
        // requires a fresh trip to the top before counting resumes.
        this.abandonRepetition();
        this.wasAtTop = false;
      } else {
        completed = this.advanceSquat(observation);
      }
    }

    const reported = this.reportedPosture();
    this.previousReported = reported;

    return {
      timestampMs: now,
      reportedPosture: reported,
      squatPhase: this.phase,
      repetitionCount: this.repetitions.length,
      completedRepetition: completed,
    };
  }

  public summary(): SessionSummary {
    const durations = this.repetitions.map((rep) => rep.durationMs);
    const totalDuration = durations.reduce((sum, value) => sum + value, 0);
    const formEventCounts = { ...EMPTY_FORM_COUNTS };
    let bestDepth = 0;
    for (const repetition of this.repetitions) {
      if (repetition.depth > bestDepth) bestDepth = repetition.depth;
      for (const event of repetition.formEvents) formEventCounts[event] += 1;
    }
    return {
      startedAtMs: this.startedAtMs ?? 0,
      endedAtMs: this.endedAtMs,
      repetitions: [...this.repetitions],
      repetitionCount: this.repetitions.length,
      bestDepth,
      averageDurationMs:
        this.repetitions.length === 0
          ? 0
          : totalDuration / this.repetitions.length,
      postureTimelineMs: { ...this.timeline },
      formEventCounts,
    };
  }

  /** Tracks the run of consecutive frames sharing a static posture. */
  private trackCandidate(observation: PoseObservation): void {
    const sample: ElevationSample = {
      timestampMs: observation.timestampMs,
      elevation: observation.hipElevation,
    };
    const current = this.candidate;
    if (!current || current.posture !== observation.posture) {
      this.candidate = {
        posture: observation.posture,
        sinceMs: observation.timestampMs,
        window: [sample],
      };
      return;
    }
    current.window.push(sample);
    const cutoff = observation.timestampMs - SIT_HOLD_MS;
    let drop = 0;
    while (
      drop < current.window.length - 1 &&
      (current.window[drop] as ElevationSample).timestampMs < cutoff
    ) {
      drop += 1;
    }
    if (drop > 0) current.window.splice(0, drop);
  }

  /** Promotes a held candidate to the committed posture. Returns true when the
   * subject has just settled into a resting posture, which cancels any squat
   * repetition in flight. */
  private promoteCandidate(now: number): boolean {
    const candidate = this.candidate;
    if (!candidate) return false;
    const held = now - candidate.sinceMs;

    if (candidate.posture === "standing" && held >= STAND_HOLD_MS) {
      this.committed = "standing";
      return false;
    }
    if (candidate.posture === "lying" && held >= LIE_HOLD_MS) {
      const wasLying = this.committed === "lyingDown";
      this.committed = "lyingDown";
      return !wasLying;
    }
    if (candidate.posture === "crouched" && held >= SIT_HOLD_MS) {
      // A squat pauses briefly at depth and keeps moving; a seated subject
      // holds a steady hip height. Stability is what separates them.
      let lowest = Number.POSITIVE_INFINITY;
      let highest = Number.NEGATIVE_INFINITY;
      for (const sample of candidate.window) {
        if (sample.elevation < lowest) lowest = sample.elevation;
        if (sample.elevation > highest) highest = sample.elevation;
      }
      if (highest - lowest <= SIT_STABILITY_BAND) {
        const wasSitting = this.committed === "sitting";
        this.committed = "sitting";
        return !wasSitting;
      }
    }
    return false;
  }

  private advanceSquat(observation: PoseObservation): Repetition | undefined {
    const elevation = observation.hipElevation;
    const now = observation.timestampMs;

    switch (this.phase) {
      case "idle": {
        if (elevation >= SQUAT_TOP_ELEVATION) {
          this.wasAtTop = true;
        } else if (this.wasAtTop) {
          this.phase =
            elevation <= SQUAT_BOTTOM_ELEVATION ? "bottom" : "descending";
          this.cycleStartMs = now;
          this.minElevation = elevation;
          this.deepest = observation;
        }
        return undefined;
      }
      case "descending": {
        this.trackDepth(observation);
        if (elevation <= SQUAT_BOTTOM_ELEVATION) {
          this.phase = "bottom";
        } else if (elevation >= SQUAT_TOP_ELEVATION) {
          this.abandonRepetition();
          this.wasAtTop = true;
        } else if (now - this.cycleStartMs > SQUAT_MAX_CYCLE_MS) {
          this.abandonRepetition();
          this.wasAtTop = false;
        }
        return undefined;
      }
      case "bottom": {
        this.trackDepth(observation);
        if (elevation >= SQUAT_TOP_ELEVATION) {
          const durationMs = now - this.cycleStartMs;
          const repetition =
            durationMs >= SQUAT_MIN_CYCLE_MS && durationMs <= SQUAT_MAX_CYCLE_MS
              ? this.completeRepetition(now, durationMs)
              : undefined;
          this.abandonRepetition();
          this.wasAtTop = true;
          return repetition;
        }
        if (now - this.cycleStartMs > SQUAT_MAX_CYCLE_MS) {
          this.abandonRepetition();
          this.wasAtTop = false;
        }
        return undefined;
      }
      default:
        return undefined;
    }
  }

  private trackDepth(observation: PoseObservation): void {
    if (observation.hipElevation < this.minElevation) {
      this.minElevation = observation.hipElevation;
      this.deepest = observation;
    }
  }

  private completeRepetition(now: number, durationMs: number): Repetition {
    const deepest = this.deepest;
    const minElevation = this.minElevation;
    const formEvents: FormEvent[] = [];
    if (minElevation > SQUAT_BOTTOM_ELEVATION - SHALLOW_DEPTH_MARGIN) {
      formEvents.push("shallowDepth");
    }
    if (deepest && deepest.torsoAngleDeg >= FORWARD_LEAN_DEG) {
      formEvents.push("forwardLean");
    }
    if (
      deepest &&
      Math.abs(deepest.leftKneeAngle - deepest.rightKneeAngle) >=
        UNEVEN_KNEE_DEG
    ) {
      formEvents.push("uneven");
    }
    const repetition: Repetition = {
      index: this.repetitions.length + 1,
      startMs: this.cycleStartMs,
      endMs: now,
      durationMs,
      minElevation,
      depth: (SQUAT_TOP_ELEVATION - minElevation) / SQUAT_TOP_ELEVATION,
      formEvents,
    };
    this.repetitions.push(repetition);
    return repetition;
  }

  private abandonRepetition(): void {
    this.phase = "idle";
    this.cycleStartMs = 0;
    this.minElevation = Number.POSITIVE_INFINITY;
    this.deepest = undefined;
  }

  private reportedPosture(): ReportedPosture {
    return this.phase === "idle" ? this.committed : "squatting";
  }
}

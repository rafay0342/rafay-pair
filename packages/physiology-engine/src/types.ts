/**
 * Canonical types for the physiology engines.
 *
 * Normative definitions live in `engines/signal-quality/SPEC.md`,
 * `engines/pulse-estimation-spec/SPEC.md`,
 * `engines/breathing-estimation-spec/SPEC.md`, and
 * `engines/calorie-estimation-spec/SPEC.md`. This package is the TypeScript
 * reference implementation; iOS and Android implement the same specifications
 * independently.
 */

export type QualityBand = "poor" | "fair" | "good";
export type ConfidenceBand = "low" | "moderate" | "high";

export interface SignalQuality {
  readonly score: number;
  readonly band: QualityBand;
  readonly coverage: number;
  readonly motion: number;
  readonly periodicity: number;
  readonly amplitude: number;
  readonly stability: number;
}

/**
 * A single frame reduced to the two channel means the estimator needs. Raw
 * frames are never retained; the capture layer produces these and releases the
 * buffer.
 */
export interface PulseSample {
  readonly timestampMs: number;
  /** Mean red channel over the region of interest, `0…255`. */
  readonly red: number;
  /** Mean green channel over the region of interest, `0…255`. */
  readonly green: number;
}

export type PulseRejectionReason =
  | "tooShort"
  | "fingerNotDetected"
  | "excessiveMotion"
  | "noPeriodicity"
  | "unstable"
  | "outOfRange";

/**
 * Provenance is part of the type, not a convention. There is no variant that can
 * carry a measured-grade reading, so nothing downstream can promote an estimate.
 */
export interface MeasuredPulse {
  readonly status: "measured";
  readonly bpm: number;
  readonly durationMs: number;
  readonly sampleCount: number;
  readonly effectiveSampleRateHz: number;
  readonly quality: SignalQuality;
  readonly confidence: number;
  readonly confidenceBand: ConfidenceBand;
  readonly source: "phone_camera_ppg";
  readonly kind: "app_estimated";
  readonly measuredAtMs: number;
}

export interface RejectedPulse {
  readonly status: "rejected";
  readonly reason: PulseRejectionReason;
  readonly durationMs: number;
  readonly sampleCount: number;
  readonly quality: SignalQuality;
}

export type PulseResult = MeasuredPulse | RejectedPulse;

/** One frame of the pose-derived breathing signal. */
export interface BreathingSample {
  readonly timestampMs: number;
  /** Shoulder-centre height divided by torso scale; distance-invariant. */
  readonly chestOffset: number;
  /** Whether the pose engine considered the source frame valid. */
  readonly tracked: boolean;
}

export type BreathingRejectionReason =
  | "tooShort"
  | "notTracked"
  | "excessiveMotion"
  | "noPeriodicity"
  | "unstable"
  | "outOfRange";

export interface MeasuredBreathing {
  readonly status: "measured";
  readonly breathsPerMinute: number;
  readonly durationMs: number;
  readonly sampleCount: number;
  readonly effectiveSampleRateHz: number;
  readonly quality: SignalQuality;
  readonly confidence: number;
  readonly confidenceBand: ConfidenceBand;
  readonly source: "phone_camera_motion";
  readonly kind: "app_estimated";
  readonly measuredAtMs: number;
}

export interface RejectedBreathing {
  readonly status: "rejected";
  readonly reason: BreathingRejectionReason;
  readonly durationMs: number;
  readonly sampleCount: number;
  readonly quality: SignalQuality;
}

export type BreathingResult = MeasuredBreathing | RejectedBreathing;

export interface BreathingPattern {
  readonly inhaleMs: number;
  readonly holdMs: number;
  readonly exhaleMs: number;
  readonly holdAfterMs: number;
  readonly cycles: number;
}

export type BreathingPhase =
  "inhale" | "hold" | "exhale" | "holdAfter" | "complete";

export interface BreathingPhaseState {
  readonly phase: BreathingPhase;
  readonly cycleIndex: number;
  /** Progress through the current phase, `0…1`. Always 1 when complete. */
  readonly progress: number;
  readonly remainingMs: number;
}

/**
 * One frame of the face-derived rPPG signal.
 *
 * No image is retained: the capture layer produces these six numbers and
 * releases the buffer, exactly as the fingertip path does.
 */
export interface FaceRppgSample {
  readonly timestampMs: number;
  /** Mean green channel over the facial region, `0…255`. */
  readonly green: number;
  /** Mean brightness of the same region; drives the lighting gate. */
  readonly luma: number;
  /** Detected face box area as a fraction of the frame. */
  readonly faceArea: number;
  readonly faceCenterX: number;
  readonly faceCenterY: number;
}

export type FaceRppgRejectionReason =
  | "tooShort"
  | "faceNotStable"
  | "unstableLighting"
  | "excessiveMotion"
  | "noPeriodicity"
  | "unstable"
  | "outOfRange";

/**
 * `experimental` is a literal on the type, so no consumer can strip the caveat.
 * Specification §6 forbids this result from the heart visualization, the
 * consent-gated share, and the stored latest pulse.
 */
export interface MeasuredFaceRppg {
  readonly status: "measured";
  readonly bpm: number;
  readonly durationMs: number;
  readonly sampleCount: number;
  readonly effectiveSampleRateHz: number;
  readonly quality: SignalQuality;
  readonly lumaSwing: number;
  readonly confidence: number;
  readonly confidenceBand: ConfidenceBand;
  readonly source: "face_camera_rppg";
  readonly kind: "app_estimated";
  readonly experimental: true;
  readonly measuredAtMs: number;
}

export interface RejectedFaceRppg {
  readonly status: "rejected";
  readonly reason: FaceRppgRejectionReason;
  readonly durationMs: number;
  readonly sampleCount: number;
  readonly quality: SignalQuality;
  readonly lumaSwing: number;
}

export type FaceRppgResult = MeasuredFaceRppg | RejectedFaceRppg;

/**
 * One hop of microphone-derived features.
 *
 * This type deliberately carries no audio. It is the boundary the retention rule
 * is enforced at: three scalars at 30 Hz, roughly 0.4% of the data rate of the
 * audio itself, from which no intelligible content is reconstructible.
 */
export interface AudioHopFeature {
  readonly timestampMs: number;
  /** Root-mean-square energy of the band-passed hop. */
  readonly rms: number;
  readonly zeroCrossingRate: number;
  /** Peak absolute amplitude before filtering, used to detect clipping. */
  readonly peak: number;
}

export type AudioBreathingRejectionReason =
  | "tooShort"
  | "notAudible"
  | "tooNoisy"
  | "noPeriodicity"
  | "unstable"
  | "outOfRange";

export interface MeasuredAudioBreathing {
  readonly status: "measured";
  readonly breathsPerMinute: number;
  readonly durationMs: number;
  readonly hopCount: number;
  readonly effectiveSampleRateHz: number;
  readonly quality: SignalQuality;
  readonly confidence: number;
  readonly confidenceBand: ConfidenceBand;
  readonly source: "phone_microphone";
  readonly kind: "app_estimated";
  readonly measuredAtMs: number;
}

export interface RejectedAudioBreathing {
  readonly status: "rejected";
  readonly reason: AudioBreathingRejectionReason;
  readonly durationMs: number;
  readonly hopCount: number;
  readonly quality: SignalQuality;
}

export type AudioBreathingResult =
  MeasuredAudioBreathing | RejectedAudioBreathing;

export type CalorieActivity =
  "rest" | "guidedBreathing" | "squat" | "bodyweightMixed" | "walkingInPlace";

export type CalorieInput =
  "duration" | "repetitions" | "bodyMass" | "poseConfidence";

export type CalorieBandLabel = "moderate" | "wide" | "veryWide";

export interface CalorieEstimateInput {
  readonly activity: CalorieActivity;
  readonly durationMs: number;
  readonly repetitions?: number;
  /** Only present when the user chose to provide it. */
  readonly bodyMassKg?: number;
  readonly poseConfidence?: number;
}

export interface CalorieEstimate {
  readonly estimatedKcal: number;
  readonly algorithmVersion: string;
  readonly activity: CalorieActivity;
  readonly durationMs: number;
  readonly repetitions: number;
  readonly met: number;
  readonly bodyMassKg: number;
  readonly inputsUsed: readonly CalorieInput[];
  readonly confidenceBand: {
    readonly lowKcal: number;
    readonly highKcal: number;
    readonly label: CalorieBandLabel;
  };
}

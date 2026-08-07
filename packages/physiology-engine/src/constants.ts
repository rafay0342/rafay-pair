/**
 * Every tunable in the physiology engines, in one place.
 *
 * These values are normative and appear identically in the Swift and Kotlin
 * ports. Changing one without changing it everywhere breaks the golden vectors,
 * which is exactly the intent.
 */

// Shared periodic-signal core — engines/signal-quality/SPEC.md
export const RESAMPLE_HZ = 30;
export const RESAMPLE_STEP_MS = 1000 / RESAMPLE_HZ;

export const QUALITY_GOOD_SCORE = 0.75;
export const QUALITY_FAIR_SCORE = 0.5;
export const CONFIDENCE_HIGH = 0.7;
export const CONFIDENCE_MODERATE = 0.45;
/**
 * How a signal's harmonics fold decides which way an ambiguous correlation peak
 * should be resolved, and it is a property of the physics rather than a tuning
 * knob.
 *
 * `SUBHARMONIC_RATIO` applies where one physical event produces one signal cycle
 * — a heartbeat, a chest rise. A peak at twice the true lag is then a
 * mathematical artifact of periodicity, so a shorter lag that merely correlates
 * comparably should win.
 *
 * `SUBHARMONIC_MARGIN` applies where one physical cycle produces two energy
 * bursts — breath sound, which is loud on the inhale and again on the exhale.
 * There the half-lag always correlates well, so the shorter lag may only win by
 * explaining the signal at least as well as the peak.
 */
export const SUBHARMONIC_RATIO = 0.85;
export const SUBHARMONIC_MARGIN = 0.02;

// Pulse — engines/pulse-estimation-spec/SPEC.md
export const FINGER_MIN_RED = 60;
export const FINGER_MAX_GREEN = 190;
export const FINGER_MIN_RED_EXCESS = 25;

export const PULSE_DETREND_WINDOW_SAMPLES = 31;
export const PULSE_SMOOTH_WINDOW_SAMPLES = 5;
export const PULSE_MIN_BPM = 42;
export const PULSE_MAX_BPM = 210;

export const PULSE_MOTION_SCALE = 6;
export const PULSE_STABILITY_WINDOW_SAMPLES = 150;
export const PULSE_STABILITY_STEP_SAMPLES = 45;
export const PULSE_STABILITY_SCALE = 20;
export const PULSE_CONFIDENCE_FULL_DURATION_MS = 20_000;

export const PULSE_MIN_DURATION_MS = 8_000;
export const PULSE_MAX_DURATION_MS = 45_000;
export const PULSE_MIN_COVERAGE = 0.9;
export const PULSE_MIN_PERIODICITY = 0.45;
export const PULSE_MAX_MOTION = 0.35;
export const PULSE_MIN_STABILITY = 0.3;

export const PULSE_FRESHNESS_MS = 300_000;

// Breathing — engines/breathing-estimation-spec/SPEC.md
export const BREATHING_DETREND_WINDOW_SAMPLES = 301;
export const BREATHING_SMOOTH_WINDOW_SAMPLES = 25;
export const BREATHING_MIN_PER_MINUTE = 6;
export const BREATHING_MAX_PER_MINUTE = 36;

export const BREATHING_MOTION_SCALE = 0.4;
export const BREATHING_STABILITY_WINDOW_SAMPLES = 450;
export const BREATHING_STABILITY_STEP_SAMPLES = 150;
export const BREATHING_STABILITY_SCALE = 6;
export const BREATHING_CONFIDENCE_FULL_DURATION_MS = 45_000;

export const BREATHING_MIN_DURATION_MS = 20_000;
export const BREATHING_MIN_COVERAGE = 0.8;
export const BREATHING_MIN_PERIODICITY = 0.4;
export const BREATHING_MAX_MOTION = 0.5;
export const BREATHING_MIN_STABILITY = 0.3;

// Microphone breathing — engines/breathing-estimation-spec/MICROPHONE.md
export const AUDIO_SAMPLE_RATE_HZ = 16_000;
export const AUDIO_HIGH_PASS_HZ = 200;
export const AUDIO_LOW_PASS_HZ = 2_000;
/** One hop per 33.3 ms, giving the 30 Hz the shared core expects. */
export const AUDIO_HOP_SAMPLES = 533;

export const AUDIO_RMS_FLOOR = 0.0015;
export const AUDIO_PEAK_CLIP = 0.98;
export const AUDIO_ZCR_MIN = 0.02;
export const AUDIO_ZCR_MAX = 0.45;

export const MIC_MOTION_SCALE = 0.05;
export const MIC_CONFIDENCE_FULL_DURATION_MS = 45_000;
export const MIC_MIN_DURATION_MS = 20_000;
/** Lower than the camera estimate: calm breathing legitimately has quiet gaps. */
export const MIC_MIN_COVERAGE = 0.6;
export const MIC_MIN_PERIODICITY = 0.4;
export const MIC_MAX_MOTION = 0.6;
export const MIC_MIN_STABILITY = 0.3;

// Calories — engines/calorie-estimation-spec/SPEC.md
export const CALORIE_ALGORITHM_VERSION = "1.0.0";
export const DEFAULT_BODY_MASS_KG = 70;

export const MET_REST = 1.3;
export const MET_GUIDED_BREATHING = 1.3;
export const MET_SQUAT = 5;
export const MET_BODYWEIGHT_MIXED = 4.5;
export const MET_WALKING_IN_PLACE = 3.5;

export const CALORIE_FULL_INTENSITY_REPS_PER_MINUTE = 20;
export const CALORIE_BASE_UNCERTAINTY = 0.25;
export const CALORIE_NO_BODY_MASS_PENALTY = 0.2;
export const CALORIE_SHORT_SESSION_PENALTY = 0.1;
export const CALORIE_LOW_CONFIDENCE_PENALTY = 0.15;
export const CALORIE_SHORT_SESSION_MS = 60_000;
export const CALORIE_LOW_POSE_CONFIDENCE = 0.5;
export const CALORIE_MAX_UNCERTAINTY = 0.75;

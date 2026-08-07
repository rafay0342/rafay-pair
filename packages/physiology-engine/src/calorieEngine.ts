/**
 * Estimated energy expenditure — reference implementation of
 * `engines/calorie-estimation-spec/SPEC.md`.
 *
 * The honesty rules are structural rather than editorial: the output field is
 * `estimatedKcal`, every result carries an explicit confidence band and the
 * list of inputs that informed it, and there is no field a screen could render
 * without the qualifier.
 */

import {
  CALORIE_ALGORITHM_VERSION,
  CALORIE_BASE_UNCERTAINTY,
  CALORIE_FULL_INTENSITY_REPS_PER_MINUTE,
  CALORIE_LOW_CONFIDENCE_PENALTY,
  CALORIE_LOW_POSE_CONFIDENCE,
  CALORIE_MAX_UNCERTAINTY,
  CALORIE_NO_BODY_MASS_PENALTY,
  CALORIE_SHORT_SESSION_MS,
  CALORIE_SHORT_SESSION_PENALTY,
  DEFAULT_BODY_MASS_KG,
  MET_BODYWEIGHT_MIXED,
  MET_GUIDED_BREATHING,
  MET_REST,
  MET_SQUAT,
  MET_WALKING_IN_PLACE,
} from "./constants.js";
import { clamp, roundToTenth } from "./signal.js";
import type {
  CalorieActivity,
  CalorieBandLabel,
  CalorieEstimate,
  CalorieEstimateInput,
  CalorieInput,
} from "./types.js";

const BASE_MET: Readonly<Record<CalorieActivity, number>> = {
  rest: MET_REST,
  guidedBreathing: MET_GUIDED_BREATHING,
  squat: MET_SQUAT,
  bodyweightMixed: MET_BODYWEIGHT_MIXED,
  walkingInPlace: MET_WALKING_IN_PLACE,
};

/** Activities whose intensity is refined by repetition rate. */
const REPETITION_ACTIVITIES: ReadonlySet<CalorieActivity> = new Set([
  "squat",
  "bodyweightMixed",
]);

export function estimateCalories(input: CalorieEstimateInput): CalorieEstimate {
  const durationMs = Math.max(0, input.durationMs);
  const repetitions = Math.max(0, Math.floor(input.repetitions ?? 0));
  const bodyMassKg =
    input.bodyMassKg !== undefined && input.bodyMassKg > 0
      ? input.bodyMassKg
      : DEFAULT_BODY_MASS_KG;

  const inputsUsed: CalorieInput[] = ["duration"];
  if (input.repetitions !== undefined) inputsUsed.push("repetitions");
  if (input.bodyMassKg !== undefined && input.bodyMassKg > 0) {
    inputsUsed.push("bodyMass");
  }
  if (input.poseConfidence !== undefined) inputsUsed.push("poseConfidence");

  const durationMinutes = durationMs / 60_000;
  const baseMet = BASE_MET[input.activity];
  const met =
    REPETITION_ACTIVITIES.has(input.activity) && durationMinutes > 0
      ? baseMet * intensityFactor(repetitions / durationMinutes)
      : baseMet;

  const estimatedKcal =
    durationMs < 1000 ? 0 : met * bodyMassKg * (durationMs / 3_600_000);

  let uncertainty = CALORIE_BASE_UNCERTAINTY;
  if (!inputsUsed.includes("bodyMass")) {
    uncertainty += CALORIE_NO_BODY_MASS_PENALTY;
  }
  if (durationMs < CALORIE_SHORT_SESSION_MS) {
    uncertainty += CALORIE_SHORT_SESSION_PENALTY;
  }
  if (
    input.poseConfidence !== undefined &&
    input.poseConfidence < CALORIE_LOW_POSE_CONFIDENCE
  ) {
    uncertainty += CALORIE_LOW_CONFIDENCE_PENALTY;
  }
  uncertainty = Math.min(CALORIE_MAX_UNCERTAINTY, uncertainty);

  const rounded = roundToTenth(estimatedKcal);
  return {
    estimatedKcal: rounded,
    algorithmVersion: CALORIE_ALGORITHM_VERSION,
    activity: input.activity,
    durationMs,
    repetitions,
    met,
    bodyMassKg,
    inputsUsed,
    confidenceBand: {
      lowKcal: roundToTenth(rounded * (1 - uncertainty)),
      highKcal: roundToTenth(rounded * (1 + uncertainty)),
      // A zero-length session gets the widest band rather than a rejection:
      // zero is the honest answer and there is nothing to act on.
      label: durationMs < 1000 ? "veryWide" : bandLabelOf(uncertainty),
    },
  };
}

/**
 * Twenty repetitions per minute is treated as full intensity. The clamp keeps a
 * burst of fast repetitions in a very short session from producing an absurd
 * multiplier, which is a real risk because duration is in the denominator.
 */
function intensityFactor(repsPerMinute: number): number {
  return clamp(
    0.7 +
      0.6 * clamp(repsPerMinute / CALORIE_FULL_INTENSITY_REPS_PER_MINUTE, 0, 1),
    0.7,
    1.3,
  );
}

function bandLabelOf(uncertainty: number): CalorieBandLabel {
  if (uncertainty <= 0.3) return "moderate";
  if (uncertainty <= 0.5) return "wide";
  return "veryWide";
}

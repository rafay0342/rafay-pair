/**
 * The experiment flags.
 *
 * Master specification §24 names six of them and requires that no experimental
 * physiological feature be enabled silently. This registry is the single place
 * they are declared; the Swift and Kotlin registries mirror it name for name,
 * and a parity test in each client fails if a name or a default drifts.
 *
 * Two rules hold for every entry:
 *
 * - The default is `false` for anything that estimates a physiological value.
 *   A flag that shipped enabled would not be an experiment, it would be a
 *   feature with a switch.
 * - `requiresDisclosure` marks the flags whose feature must say, in the
 *   interface, that it is experimental. It is a property of the flag rather
 *   than of the screen so that a new screen cannot forget it.
 */

export const EXPERIMENT_FLAG_NAMES = [
  "camera_ppg_face_mode",
  "camera_breathing_estimate",
  "microphone_breathing_estimate",
  "advanced_form_coaching",
  "living_body_advanced",
  "ai_relationship_memory",
] as const;

export type ExperimentFlagName = (typeof EXPERIMENT_FLAG_NAMES)[number];

export interface ExperimentFlag {
  readonly name: ExperimentFlagName;
  /** Shown to the user when the flag is offered. */
  readonly title: string;
  /** Why it is experimental, in the words a user would need. */
  readonly detail: string;
  readonly enabledByDefault: boolean;
  /**
   * Whether the feature estimates something about the body. These may never
   * default to enabled, and the registry test enforces that rather than
   * trusting each entry.
   */
  readonly physiological: boolean;
  readonly requiresDisclosure: boolean;
}

export const EXPERIMENT_FLAGS: Readonly<
  Record<ExperimentFlagName, ExperimentFlag>
> = {
  camera_ppg_face_mode: {
    name: "camera_ppg_face_mode",
    title: "Face-camera pulse",
    detail:
      "Estimates a pulse from colour change in the face. It is far less reliable than the fingertip measurement and is refused outright when the lighting drifts, because drifting light produces exactly the oscillation this mistakes for a heartbeat.",
    enabledByDefault: false,
    physiological: true,
    requiresDisclosure: true,
  },
  camera_breathing_estimate: {
    name: "camera_breathing_estimate",
    title: "Camera breathing estimate",
    detail:
      "Estimates a breathing rate from chest movement while you are already in frame. It needs your torso visible and still enough to read, and says nothing rather than guessing when it cannot.",
    enabledByDefault: false,
    physiological: true,
    requiresDisclosure: true,
  },
  microphone_breathing_estimate: {
    name: "microphone_breathing_estimate",
    title: "Microphone breathing estimate",
    detail:
      "Listens during a breathing session you started and estimates the rhythm from breath sounds. Audio becomes a few numbers as it arrives and is never recorded.",
    enabledByDefault: false,
    physiological: true,
    requiresDisclosure: true,
  },
  advanced_form_coaching: {
    name: "advanced_form_coaching",
    title: "Detailed form notes",
    detail:
      "Comments on squat depth, forward lean, and uneven weight. These are observations about movement, not medical advice, and they are wrong often enough to be worth calling experimental.",
    enabledByDefault: false,
    physiological: false,
    requiresDisclosure: true,
  },
  living_body_advanced: {
    name: "living_body_advanced",
    title: "Veins Alive",
    detail:
      "An animated body view driven by what the app already knows. It is a visualization, not a scan: nothing here measures or infers anything new about you.",
    enabledByDefault: false,
    physiological: false,
    requiresDisclosure: true,
  },
  ai_relationship_memory: {
    name: "ai_relationship_memory",
    title: "What Rafay remembers",
    detail:
      "Lets the assistant keep notes you approve, so it does not ask the same things every session. You can read and delete every entry.",
    enabledByDefault: false,
    physiological: false,
    requiresDisclosure: false,
  },
};

export function experimentFlagList(): readonly ExperimentFlag[] {
  return EXPERIMENT_FLAG_NAMES.map((name) => EXPERIMENT_FLAGS[name]);
}

export function isExperimentFlagName(
  value: string,
): value is ExperimentFlagName {
  return (EXPERIMENT_FLAG_NAMES as readonly string[]).includes(value);
}

/**
 * Resolves a flag against stored user choices.
 *
 * An unknown name resolves to `false` rather than throwing: a stored preference
 * from a build that knew a flag this one does not must not enable anything, and
 * must not crash the screen reading it either.
 */
export function isExperimentEnabled(
  name: string,
  choices: Readonly<Record<string, boolean>>,
): boolean {
  if (!isExperimentFlagName(name)) return false;
  return choices[name] ?? EXPERIMENT_FLAGS[name].enabledByDefault;
}

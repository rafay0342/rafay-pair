import { describe, expect, it } from "vitest";

import {
  EXPERIMENT_FLAGS,
  EXPERIMENT_FLAG_NAMES,
  experimentFlagList,
  isExperimentEnabled,
} from "./index.js";

describe("experiment flags", () => {
  it("declares exactly the six the specification names", () => {
    // Master specification §24. The list is checked rather than described so a
    // flag cannot be quietly dropped or renamed.
    expect([...EXPERIMENT_FLAG_NAMES]).toEqual([
      "camera_ppg_face_mode",
      "camera_breathing_estimate",
      "microphone_breathing_estimate",
      "advanced_form_coaching",
      "living_body_advanced",
      "ai_relationship_memory",
    ]);
  });

  it("never enables a physiological experiment by default", () => {
    // "No experimental physiological feature may be enabled silently." A
    // default of true would make that sentence false, whatever the screen does.
    for (const flag of experimentFlagList()) {
      if (flag.physiological)
        expect(flag.enabledByDefault, flag.name).toBe(false);
    }
  });

  it("keeps every entry keyed by its own name", () => {
    for (const name of EXPERIMENT_FLAG_NAMES) {
      expect(EXPERIMENT_FLAGS[name].name).toBe(name);
      expect(EXPERIMENT_FLAGS[name].title.length).toBeGreaterThan(0);
      expect(EXPERIMENT_FLAGS[name].detail.length).toBeGreaterThan(40);
    }
  });

  it("treats an unknown stored preference as off rather than as an error", () => {
    // A preference saved by a build that knew a flag this one does not must
    // neither enable anything nor crash the screen reading it.
    expect(
      isExperimentEnabled("from_a_newer_build", { from_a_newer_build: true }),
    ).toBe(false);
    expect(isExperimentEnabled("camera_breathing_estimate", {})).toBe(false);
    expect(
      isExperimentEnabled("camera_breathing_estimate", {
        camera_breathing_estimate: true,
      }),
    ).toBe(true);
  });
});

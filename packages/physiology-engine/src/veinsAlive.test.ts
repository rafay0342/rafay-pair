import { describe, expect, it } from "vitest";

import {
  VEINS_DISCLOSURE,
  veinsDrivers,
  type VeinsInput,
} from "./veinsAlive.js";

const base: VeinsInput = {
  mode: "calm",
  pulseBpm: null,
  breathingPhase: null,
  breathingProgress: 0,
  repetitionsPerMinute: null,
  activeMuscles: [],
};

describe("Veins Alive", () => {
  it("rests rather than inventing a rate when no fresh pulse exists", () => {
    // The whole point of the module. A vascular network pulsing at a plausible
    // 72 would be a fabricated measurement wearing an animation's clothes.
    const resting = veinsDrivers(base);
    expect(resting.contractionPeriodMs).toBeNull();
    expect(resting.pulseProvenance).toBe("none");
  });

  it("animates from an estimate, and says that is what it is", () => {
    const driven = veinsDrivers({ ...base, pulseBpm: 60 });
    expect(driven.contractionPeriodMs).toBe(1000);
    expect(driven.pulseProvenance).toBe("estimated");
  });

  it("refuses an implausible rate instead of clamping it", () => {
    // Clamping would turn a wrong number into a believable one.
    for (const bpm of [
      0,
      20,
      41,
      211,
      400,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const result = veinsDrivers({ ...base, pulseBpm: bpm });
      expect(result.contractionPeriodMs, String(bpm)).toBeNull();
      expect(result.pulseProvenance, String(bpm)).toBe("none");
    }
  });

  it("glows with the breath and not otherwise", () => {
    expect(
      veinsDrivers({ ...base, breathingPhase: "inhale", breathingProgress: 0 })
        .chestGlow,
    ).toBe(0);
    expect(
      veinsDrivers({ ...base, breathingPhase: "inhale", breathingProgress: 1 })
        .chestGlow,
    ).toBe(1);
    expect(
      veinsDrivers({ ...base, breathingPhase: "hold", breathingProgress: 0.5 })
        .chestGlow,
    ).toBe(1);
    expect(
      veinsDrivers({ ...base, breathingPhase: "exhale", breathingProgress: 1 })
        .chestGlow,
    ).toBe(0);
    // No session running: the chest does not breathe on screen while the user
    // is doing something else.
    expect(veinsDrivers(base).chestGlow).toBe(0);
  });

  it("keeps intensity inside its range whatever the effort", () => {
    expect(veinsDrivers(base).intensity).toBeCloseTo(0.15, 6);
    expect(veinsDrivers({ ...base, mode: "workout" }).intensity).toBeCloseTo(
      0.45,
      6,
    );
    const flatOut = veinsDrivers({
      ...base,
      mode: "workout",
      repetitionsPerMinute: 500,
    });
    expect(flatOut.intensity).toBeLessThanOrEqual(1);
    expect(flatOut.intensity).toBeGreaterThan(0.9);
  });

  it("carries the disclosure and cannot be handed one to shorten", () => {
    expect(veinsDrivers(base).disclosure).toBe(VEINS_DISCLOSURE);
    expect(VEINS_DISCLOSURE).toContain("not a medical scan");
  });

  it("keeps the exercise's own muscle order and drops repeats", () => {
    const drivers = veinsDrivers({
      ...base,
      activeMuscles: ["quadriceps", "glutes", "quadriceps"],
    });
    expect(drivers.activeMuscles).toEqual(["quadriceps", "glutes"]);
  });
});

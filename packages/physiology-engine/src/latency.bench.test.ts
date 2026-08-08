import { describe, expect, it } from "vitest";

import { estimateBreathing } from "./breathingEngine.js";
import { estimatePulse } from "./pulseEngine.js";
import type { BreathingSample, PulseSample } from "./types.js";

/**
 * Master specification §20: pulse processing latency.
 *
 * Scoring happens once, when the user stops measuring, and the interface waits
 * for it. Anything approaching a second would read as the app having hung at
 * the moment the user most wants an answer, so the ceiling is set where a
 * person would not notice a wait at all.
 *
 * Loose against the measured cost on purpose: a tight ceiling fails on a loaded
 * CI runner and teaches everyone to ignore the check, and a latency check people
 * ignore is worse than none.
 */
const SCORING_CEILING_MS = 250;

/** A full session at 30 fps: what the estimator is actually handed. */
function pulseSession(): PulseSample[] {
  const samples: PulseSample[] = [];
  for (let index = 0; index < 30 * 20; index += 1) {
    const t = index / 30;
    const beat = Math.sin(2 * Math.PI * 1.2 * t);
    samples.push({
      timestampMs: index * (1000 / 30),
      red: 200 + 6 * beat,
      green: 40 + 2 * beat,
    });
  }
  return samples;
}

function breathingSession(): BreathingSample[] {
  const samples: BreathingSample[] = [];
  for (let index = 0; index < 30 * 45; index += 1) {
    const t = index / 30;
    samples.push({
      timestampMs: index * (1000 / 30),
      chestOffset: 1.4 + 0.02 * Math.sin(2 * Math.PI * 0.22 * t),
      tracked: true,
    });
  }
  return samples;
}

describe("scoring latency", () => {
  it("scores a full pulse session while the user is still looking at the button", () => {
    const samples = pulseSession();
    const started = performance.now();
    estimatePulse(samples, samples[samples.length - 1]!.timestampMs);
    expect(performance.now() - started).toBeLessThan(SCORING_CEILING_MS);
  });

  it("scores a full breathing session just as quickly", () => {
    const samples = breathingSession();
    const started = performance.now();
    estimateBreathing(samples, samples[samples.length - 1]!.timestampMs);
    expect(performance.now() - started).toBeLessThan(SCORING_CEILING_MS);
  });
});

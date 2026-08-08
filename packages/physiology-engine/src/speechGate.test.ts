import { describe, expect, it } from "vitest";

import { SpeechGate, frameRms } from "./speechGate.js";

/** `engines/speech-gate/SPEC.md`. */
function run(gate: SpeechGate, level: number, frames: number): boolean[] {
  return Array.from({ length: frames }, () => gate.accept(level).transmit);
}

describe("speech gate", () => {
  it("stays shut through a quiet room", () => {
    const gate = new SpeechGate();
    expect(run(gate, 0.0006, 200).some(Boolean)).toBe(false);
  });

  it("opens for someone speaking into the phone", () => {
    const gate = new SpeechGate();
    run(gate, 0.0008, 100); // settle on a quiet room
    const speech = run(gate, 0.12, 25);
    expect(speech.some(Boolean)).toBe(true);
  });

  it("stays shut for a television across the room", () => {
    const gate = new SpeechGate();
    run(gate, 0.001, 100);
    // Well above the floor by ratio, but nowhere near the phone. A ratio alone
    // would let this through in a quiet room; the absolute near minimum is what
    // refuses it.
    expect(run(gate, 0.006, 200).some(Boolean)).toBe(false);
  });

  it("does not close during the pauses inside a sentence", () => {
    const gate = new SpeechGate();
    run(gate, 0.0008, 100);
    run(gate, 0.12, 10); // a word
    const pause = run(gate, 0.004, 8); // the gap between words
    // Without hangover the provider would hear speech chopped into pieces,
    // which is heard at the other end as an assistant that interrupts.
    expect(pause.every(Boolean)).toBe(true);
  });

  it("closes once the person has actually stopped", () => {
    const gate = new SpeechGate();
    run(gate, 0.0008, 100);
    run(gate, 0.12, 20);
    const after = run(gate, 0.0009, 40);
    expect(after.at(-1)).toBe(false);
  });

  it("adopts a noisy room slowly, and a quiet one quickly", () => {
    const gate = new SpeechGate();
    // A kitchen: sustained noise is eventually accepted as the floor rather
    // than treated as speech forever.
    const noisy = run(gate, 0.02, 4000);
    expect(noisy.at(-1)).toBe(false);

    // And when it goes quiet, the floor follows within a few frames rather
    // than leaving the gate deaf.
    run(gate, 0.0008, 40);
    expect(run(gate, 0.12, 5).some(Boolean)).toBe(true);
  });

  it("measures a frame the way the specification says", () => {
    expect(frameRms(new Int16Array(0))).toBe(0);
    expect(frameRms(new Int16Array([0, 0, 0]))).toBe(0);
    // Full-scale square wave is 1.0 by definition.
    expect(
      frameRms(new Int16Array([32767, -32768, 32767, -32768])),
    ).toBeCloseTo(1, 2);
  });

  it("forgets the previous room when reset", () => {
    const gate = new SpeechGate();
    run(gate, 0.05, 3000);
    gate.reset();
    run(gate, 0.0008, 50);
    expect(run(gate, 0.12, 5).some(Boolean)).toBe(true);
  });
});

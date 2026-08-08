/**
 * The speech gate.
 *
 * `engines/speech-gate/SPEC.md` is normative. It decides, on the device and
 * before anything is transmitted, whether a frame is the person holding the
 * phone or the rest of the room.
 *
 * It is near-field gating, not speaker identification: it distinguishes close
 * from far, not this person from that person. Someone else speaking directly
 * into the same phone will pass it. That limit is written here as well as in
 * the specification, because the name of this file is the sort of thing that
 * gets read instead of the specification.
 */

export const GATE_FLOOR_FALL = 0.2;
export const GATE_FLOOR_RISE = 0.002;
export const GATE_FLOOR_MINIMUM = 0.0008;
export const GATE_OPEN_RATIO = 6;
export const GATE_CLOSE_RATIO = 3;
export const GATE_NEAR_MINIMUM = 0.01;
export const GATE_HANGOVER_FRAMES = 12;

export interface GateDecision {
  /** What the caller acts on: send this frame, or drop it. */
  readonly transmit: boolean;
  readonly open: boolean;
  readonly rms: number;
  readonly floor: number;
}

/** Root-mean-square amplitude of one PCM16 frame, normalised to `0...1`. */
export function frameRms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const sample of samples) {
    const normalised = sample / 32768;
    total += normalised * normalised;
  }
  return Math.sqrt(total / samples.length);
}

/**
 * Stateful across a session, because the floor is a memory of the room.
 *
 * One instance per voice session. Reusing one across sessions would carry the
 * previous room's noise into a new one.
 */
export class SpeechGate {
  #floor = GATE_FLOOR_MINIMUM;
  #open = false;
  #hangover = 0;

  /** Every frame must be offered, including ones that are not transmitted. */
  public accept(rms: number): GateDecision {
    // The floor falls quickly and rises slowly. A floor that rose quickly would
    // climb during speech until the speaker no longer cleared it, and the gate
    // would close mid-sentence.
    const rate = rms < this.#floor ? GATE_FLOOR_FALL : GATE_FLOOR_RISE;
    this.#floor = Math.max(
      GATE_FLOOR_MINIMUM,
      this.#floor + (rms - this.#floor) * rate,
    );

    const openLevel = Math.max(
      this.#floor * GATE_OPEN_RATIO,
      GATE_NEAR_MINIMUM,
    );
    const closeLevel = this.#floor * GATE_CLOSE_RATIO;

    if (!this.#open) {
      // Opening is harder than staying open, which is how a human listener
      // works too, and is what stops a voice at the boundary from chopping a
      // sentence into fragments.
      if (rms >= openLevel) {
        this.#open = true;
        this.#hangover = GATE_HANGOVER_FRAMES;
      }
    } else if (rms >= closeLevel) {
      this.#hangover = GATE_HANGOVER_FRAMES;
    } else {
      this.#hangover -= 1;
      if (this.#hangover <= 0) this.#open = false;
    }

    return {
      transmit: this.#open,
      open: this.#open,
      rms,
      floor: this.#floor,
    };
  }

  public reset(): void {
    this.#floor = GATE_FLOOR_MINIMUM;
    this.#open = false;
    this.#hangover = 0;
  }
}

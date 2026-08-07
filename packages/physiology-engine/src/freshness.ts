import { PULSE_FRESHNESS_MS } from "./constants.js";
import type { MeasuredPulse } from "./types.js";

/**
 * Freshness is a property of the reading, not of the screen.
 *
 * Master specification §4 forbids animating an old rate as if it were current.
 * Both clients and the sharing path use these helpers so that a stale value is
 * stale everywhere, including for a partner.
 */

export function pulseAgeMs(pulse: MeasuredPulse, nowMs: number): number {
  return Math.max(0, nowMs - pulse.measuredAtMs);
}

export function isPulseFresh(pulse: MeasuredPulse, nowMs: number): boolean {
  return pulseAgeMs(pulse, nowMs) < PULSE_FRESHNESS_MS;
}

import { describe, expect, it } from "vitest";

import { outboxBackoffMs } from "./processor.js";

describe("outbox retry policy", () => {
  it("uses bounded exponential backoff", () => {
    expect(outboxBackoffMs(1)).toBe(1_000);
    expect(outboxBackoffMs(5)).toBe(16_000);
    expect(outboxBackoffMs(100)).toBe(15 * 60 * 1_000);
  });
});

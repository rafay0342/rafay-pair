import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  recordAiToolDecision,
  recordAuthorizationRefusal,
  recordRealtimeWithheld,
} from "./telemetry.js";

const source = readFileSync(
  fileURLToPath(new URL("./telemetry.ts", import.meta.url)),
  "utf8",
);

describe("metrics", () => {
  it("records without a configured exporter instead of throwing", () => {
    // A deployment with no OTLP endpoint is supported, and instrumentation on a
    // hot path must not become a failure mode when it is absent.
    expect(() => {
      recordAuthorizationRefusal("CONSENT_DENIED");
      recordRealtimeWithheld("live_consent");
      recordAiToolDecision("remember", "confirmation_required");
    }).not.toThrow();
  });

  it("carries no identifier into a metrics backend", () => {
    // Metrics land in a store with long retention and looser access than the
    // database. An attribute naming a user, pair, or session would quietly make
    // that store a second copy of who is doing what.
    for (const forbidden of [
      "userId",
      "user_id",
      "pairId",
      "pair_id",
      "sessionId",
      "session_id",
      "email",
      "displayName",
    ]) {
      expect(source, forbidden).not.toContain(`${forbidden}:`);
    }
  });

  it("names no capture concept", () => {
    // The server has no idea whether a camera is running, and a metric implying
    // otherwise would be the first step towards it having one.
    for (const token of ["camera", "microphone", "capture", "frame"]) {
      expect(source.toLowerCase().includes(`"${token}`), token).toBe(false);
    }
  });
});

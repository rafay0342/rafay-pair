import { describe, expect, it } from "vitest";

import {
  appAttestBindingVersion,
  androidIntegrityBindingVersion,
  createIosIntegrityChallengeSchema,
  careRequestCursorSchema,
  createAndroidIntegrityChallengeSchema,
  createCareRequestSchema,
  passwordSchema,
  registerNotificationDeviceSchema,
  realtimeEventEnvelopeSchema,
  realtimeTicketRequestSchema,
  realtimeWebSocketProtocols,
  submitAndroidIntegrityAssessmentSchema,
  submitIosIntegrityAssessmentSchema,
  updateConsentsRequestSchema,
} from "./index.js";

describe("public API contracts", () => {
  it("encodes a realtime ticket as a non-selected WebSocket subprotocol", () => {
    const ticket = "a".repeat(43);
    expect(realtimeWebSocketProtocols(ticket)).toEqual([
      "rafaypair.v1",
      `rafaypair.ticket.${ticket}`,
    ]);
    expect(() => realtimeWebSocketProtocols("not-a-ticket")).toThrow();
  });

  it("rejects realtime cursors outside PostgreSQL signed bigint range", () => {
    expect(
      realtimeTicketRequestSchema.safeParse({
        lastEventId: "9223372036854775807",
      }).success,
    ).toBe(true);
    expect(
      realtimeTicketRequestSchema.safeParse({
        lastEventId: "9223372036854775808",
      }).success,
    ).toBe(false);
  });

  it("rejects weak passwords", () => {
    expect(passwordSchema.safeParse("onlyletterslong").success).toBe(false);
    expect(passwordSchema.safeParse("correct-horse-42").success).toBe(true);
  });

  it("rejects duplicate consent capabilities", () => {
    const result = updateConsentsRequestSchema.safeParse({
      grants: [
        { capability: "care_requests", granted: true },
        { capability: "care_requests", granted: false },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("requires a client idempotency key for care requests", () => {
    expect(createCareRequestSchema.safeParse({ kind: "help" }).success).toBe(
      false,
    );
  });

  it("treats care pagination cursors as bounded opaque values", () => {
    expect(careRequestCursorSchema.safeParse("opaque_cursor-123").success).toBe(
      true,
    );
    expect(
      careRequestCursorSchema.safeParse("2026-08-07T10:00:00.000Z").success,
    ).toBe(false);
    expect(careRequestCursorSchema.safeParse("x".repeat(257)).success).toBe(
      false,
    );
  });

  it("requires a random installation id for native notification rotation", () => {
    const registration = {
      platform: "ios",
      token: "apns-token-long-enough",
    };
    expect(
      registerNotificationDeviceSchema.safeParse(registration).success,
    ).toBe(false);
    expect(
      registerNotificationDeviceSchema.safeParse({
        ...registration,
        installationId: crypto.randomUUID(),
      }).success,
    ).toBe(true);
  });

  it("bounds the Android integrity challenge and opaque provider token", () => {
    expect(androidIntegrityBindingVersion).toBe("sha256-v1");
    expect(
      createAndroidIntegrityChallengeSchema.safeParse({
        action: "session_start",
      }).success,
    ).toBe(true);
    expect(
      createAndroidIntegrityChallengeSchema.safeParse({ action: "login" })
        .success,
    ).toBe(false);
    expect(
      submitAndroidIntegrityAssessmentSchema.safeParse({
        challengeId: crypto.randomUUID(),
        action: "session_start",
        integrityToken: "a".repeat(64),
      }).success,
    ).toBe(true);
    expect(
      submitAndroidIntegrityAssessmentSchema.safeParse({
        challengeId: crypto.randomUUID(),
        action: "session_start",
        integrityToken: `provider token ${"a".repeat(64)}`,
      }).success,
    ).toBe(false);
  });

  it("binds native App Attest requests to a supported key and proof mode", () => {
    const keyId = `${"A".repeat(43)}=`;
    expect(appAttestBindingVersion).toBe("app-attest-sha256-v1");
    expect(
      createIosIntegrityChallengeSchema.safeParse({
        action: "session_start",
        supported: true,
        keyId,
      }).success,
    ).toBe(true);
    expect(
      createIosIntegrityChallengeSchema.safeParse({
        action: "session_start",
        supported: false,
        keyId,
      }).success,
    ).toBe(false);
    expect(
      submitIosIntegrityAssessmentSchema.safeParse({
        challengeId: "11111111-1111-4111-8111-111111111111",
        action: "session_start",
        mode: "assertion",
        keyId,
        assertionObject: "QUJD".repeat(32),
      }).success,
    ).toBe(true);
    expect(
      submitIosIntegrityAssessmentSchema.safeParse({
        challengeId: "11111111-1111-4111-8111-111111111111",
        action: "session_start",
        mode: "unsupported",
        assertionObject: "QUJD".repeat(32),
      }).success,
    ).toBe(false);
  });

  it("only accepts versioned realtime envelopes", () => {
    const result = realtimeEventEnvelopeSchema.safeParse({
      version: 2,
      id: crypto.randomUUID(),
      eventId: "1",
      authorizationRevision: "1",
      type: "privacy.paused",
      occurredAt: new Date().toISOString(),
      pairId: crypto.randomUUID(),
      payload: {},
    });
    expect(result.success).toBe(false);
  });
});

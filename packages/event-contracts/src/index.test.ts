import { describe, expect, it } from "vitest";

import {
  createDomainEvent,
  directionalConsentForEvent,
  domainEventSchema,
} from "./index.js";

describe("domain events", () => {
  it("creates a validated immutable-identity envelope", () => {
    const event = createDomainEvent({
      type: "privacy.paused",
      aggregateType: "privacy",
      aggregateId: crypto.randomUUID(),
      pairId: crypto.randomUUID(),
      actorUserId: crypto.randomUUID(),
      payload: {},
    });
    expect(domainEventSchema.parse(event).version).toBe(1);
  });

  it("keeps care creation and response bound to the original recipient grant", () => {
    expect(
      directionalConsentForEvent({
        type: "care.request.created",
        actorUserId: "sender",
        recipientUserId: "recipient",
      }),
    ).toEqual({
      capability: "care_requests",
      grantorUserId: "recipient",
      granteeUserId: "sender",
    });
    expect(
      directionalConsentForEvent({
        type: "care.request.responded",
        actorUserId: "recipient",
        recipientUserId: "sender",
      }),
    ).toEqual({
      capability: "care_requests",
      grantorUserId: "recipient",
      granteeUserId: "sender",
    });
  });

  it("does not consent-gate revocation control events", () => {
    expect(
      directionalConsentForEvent({
        type: "privacy.paused",
        actorUserId: "member",
        recipientUserId: "partner",
      }),
    ).toBeNull();
    expect(
      directionalConsentForEvent({
        type: "pair.disconnected",
        actorUserId: "member",
      }),
    ).toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  SessionAuthorizationError,
  SessionCoordinator,
  type Queryable,
} from "./index.js";

describe("SessionCoordinator", () => {
  it("fails closed when a durable consent row is absent", async () => {
    const query = vi
      .fn<Queryable["query"]>()
      .mockResolvedValueOnce({
        rows: [{ pair_id: crypto.randomUUID() }],
        rowCount: 1,
        command: "SELECT",
        oid: 0,
        fields: [],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            pair_id: crypto.randomUUID(),
            status: "active",
            actor_user_id: crypto.randomUUID(),
            partner_user_id: crypto.randomUUID(),
            actor_paused: false,
            partner_paused: false,
          },
        ],
        rowCount: 1,
        command: "SELECT",
        oid: 0,
        fields: [],
      })
      .mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
        command: "SELECT",
        oid: 0,
        fields: [],
      });
    const coordinator = new SessionCoordinator({
      query: query as Queryable["query"],
    });

    await expect(
      coordinator.authorizePartnerAction(crypto.randomUUID(), "care_requests"),
    ).rejects.toEqual(new SessionAuthorizationError("CONSENT_DENIED"));
  });

  it("privacy pause overrides an otherwise valid relationship", async () => {
    const query = vi
      .fn<Queryable["query"]>()
      .mockResolvedValueOnce({
        rows: [{ pair_id: crypto.randomUUID() }],
        rowCount: 1,
        command: "SELECT",
        oid: 0,
        fields: [],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            pair_id: crypto.randomUUID(),
            status: "active",
            actor_user_id: crypto.randomUUID(),
            partner_user_id: crypto.randomUUID(),
            actor_paused: true,
            partner_paused: false,
          },
        ],
        rowCount: 1,
        command: "SELECT",
        oid: 0,
        fields: [],
      });
    const coordinator = new SessionCoordinator({
      query: query as Queryable["query"],
    });
    await expect(
      coordinator.authorizePartnerAction(crypto.randomUUID(), "care_requests"),
    ).rejects.toMatchObject({
      code: "PRIVACY_PAUSED",
    });
  });
});

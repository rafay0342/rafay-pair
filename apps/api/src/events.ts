import type { PoolClient } from "pg";

import {
  realtimeEventEnvelopeSchema,
  type RealtimeEventEnvelope,
} from "@rafay-pair/api-contracts";
import { createDomainEvent } from "@rafay-pair/event-contracts";

export async function appendRealtimeOutboxEvent(
  client: PoolClient,
  input: {
    type:
      | "care.request.created"
      | "care.request.responded"
      | "privacy.paused"
      | "privacy.resumed"
      | "pair.disconnected"
      | "pulse.snapshot.shared";
    aggregateType: "pair" | "care_request" | "privacy" | "pulse";
    aggregateId: string;
    pairId: string;
    actorUserId: string;
    recipientUserId?: string;
    payload: Record<string, unknown>;
  },
): Promise<RealtimeEventEnvelope> {
  const event = createDomainEvent(input);
  const pairRevision = await client.query<{ authorization_revision: string }>(
    "SELECT authorization_revision::text FROM pairs WHERE id = $1",
    [event.pairId],
  );
  const authorizationRevision = pairRevision.rows[0]?.authorization_revision;
  if (!authorizationRevision)
    throw new Error("Realtime event pair authorization revision is missing");
  const realtimePayload = {
    ...event.payload,
    actorUserId: event.actorUserId,
    ...(event.recipientUserId
      ? { recipientUserId: event.recipientUserId }
      : {}),
  };
  // occurred_at must come from the database clock: consent enforcement
  // compares it against consent_grants.updated_at (DEFAULT now()), and an API
  // host clock behind the database clock would deny freshly consented events.
  const inserted = await client.query<{ id: string; occurred_at: Date }>(
    `
      INSERT INTO realtime_events(
        event_uuid, pair_id, event_type, payload, occurred_at, authorization_revision
      )
      VALUES ($1, $2, $3, $4, now(), $5)
      RETURNING id::text, occurred_at
    `,
    [
      event.id,
      event.pairId,
      event.type,
      realtimePayload,
      authorizationRevision,
    ],
  );
  const eventId = inserted.rows[0]?.id;
  const occurredAt = inserted.rows[0]?.occurred_at;
  if (!eventId || !occurredAt)
    throw new Error("Realtime event insert returned no id");
  await client.query(
    `
      INSERT INTO outbox_events (
        event_uuid, event_type, aggregate_type, aggregate_id, pair_id,
        actor_user_id, recipient_user_id, payload, occurred_at, authorization_revision
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `,
    [
      event.id,
      event.type,
      event.aggregateType,
      event.aggregateId,
      event.pairId,
      event.actorUserId,
      event.recipientUserId ?? null,
      { ...realtimePayload, eventId },
      occurredAt,
      authorizationRevision,
    ],
  );
  return realtimeEventEnvelopeSchema.parse({
    version: 1,
    id: event.id,
    eventId,
    authorizationRevision,
    type: event.type,
    occurredAt: occurredAt.toISOString(),
    pairId: event.pairId,
    payload: realtimePayload,
  });
}

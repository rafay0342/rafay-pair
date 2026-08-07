import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { Logger } from "pino";
import { SpanStatusCode, trace } from "@opentelemetry/api";

import {
  realtimeEventEnvelopeSchema,
  type RealtimeEventEnvelope,
} from "@rafay-pair/api-contracts";
import { directionalConsentForEvent } from "@rafay-pair/event-contracts";
import {
  decryptDeviceToken,
  deriveDeviceEncryptionKey,
  NotificationDeliveryError,
  type NotificationDevice,
  type NotificationDispatcher,
} from "@rafay-pair/notifications";
import type { RealtimeBroker } from "@rafay-pair/realtime";

import type { WorkerConfig } from "./config.js";

interface OutboxRow extends QueryResultRow {
  id: string;
  event_uuid: string;
  event_type: RealtimeEventEnvelope["type"];
  aggregate_type: string;
  aggregate_id: string;
  pair_id: string;
  actor_user_id: string;
  recipient_user_id: string | null;
  payload: Record<string, unknown> & { eventId?: unknown };
  occurred_at: Date;
  authorization_revision: string;
  attempts: number;
}

interface DeviceRow extends QueryResultRow {
  id: string;
  platform: "ios" | "android";
  token_ciphertext: string;
  status: "pending" | "succeeded" | "permanent_failure" | null;
}

export class OutboxProcessor {
  private readonly encryptionKey: string;

  public constructor(
    private readonly pool: Pool,
    private readonly broker: RealtimeBroker,
    private readonly notifications: NotificationDispatcher,
    private readonly config: WorkerConfig,
    private readonly logger: Logger,
  ) {
    this.encryptionKey = deriveDeviceEncryptionKey(
      config.sessionPepper,
      config.deviceTokenEncryptionKey,
    );
  }

  public async processAvailable(): Promise<number> {
    const claimed = await this.pool.query<OutboxRow>(
      `
        WITH candidates AS (
          SELECT event.id
          FROM outbox_events event
          WHERE event.processed_at IS NULL
            AND event.dead_lettered_at IS NULL
            AND event.available_at <= now()
            AND (event.locked_at IS NULL OR event.locked_at < now() - interval '2 minutes')
            AND NOT EXISTS (
              SELECT 1 FROM outbox_events earlier
              WHERE earlier.pair_id = event.pair_id
                AND earlier.id < event.id
                AND earlier.processed_at IS NULL
                AND earlier.dead_lettered_at IS NULL
            )
          ORDER BY event.id
          FOR UPDATE SKIP LOCKED
          LIMIT 20
        )
        UPDATE outbox_events event
        SET locked_at = now(), locked_by = $1, attempts = event.attempts + 1
        FROM candidates
        WHERE event.id = candidates.id
        RETURNING event.id::text, event.event_uuid::text, event.event_type,
                  event.aggregate_type, event.aggregate_id::text, event.pair_id::text,
                  event.actor_user_id::text, event.recipient_user_id::text,
                  event.payload, event.occurred_at,
                  event.authorization_revision::text, event.attempts
      `,
      [this.config.workerId],
    );
    await Promise.all(
      claimed.rows.map(async (event) => this.processClaimed(event)),
    );
    return claimed.rows.length;
  }

  private async processClaimed(event: OutboxRow): Promise<void> {
    const span = trace
      .getTracer("rafay-pair-worker")
      .startSpan("outbox.deliver", {
        attributes: {
          "messaging.message.id": event.event_uuid,
          "messaging.destination.name": event.pair_id,
          "rafay.event.type": event.event_type,
          "rafay.outbox.attempt": event.attempts,
        },
      });
    try {
      await this.authorizeAndDeliver(event);
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.slice(0, 2_000)
          : "unknown worker error";
      this.logger.error(
        { err: error, outboxEventId: event.id, eventType: event.event_type },
        "outbox delivery failed",
      );
      span.recordException(
        error instanceof Error
          ? error
          : new Error("Unknown outbox delivery error"),
      );
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      const deadLetter = event.attempts >= 25;
      await this.pool.query(
        `
          UPDATE outbox_events
          SET locked_at = NULL, locked_by = NULL, last_error = $3,
              available_at = now() + ($4 * interval '1 millisecond'),
              dead_lettered_at = CASE WHEN $5 THEN now() ELSE NULL END
          WHERE id = $1 AND locked_by = $2
        `,
        [
          event.id,
          this.config.workerId,
          message,
          outboxBackoffMs(event.attempts),
          deadLetter,
        ],
      );
    } finally {
      span.end();
    }
  }

  private async authorizeAndDeliver(event: OutboxRow): Promise<void> {
    const authorized = await this.markDeliveryAuthorization(event);
    if (!authorized) return;

    // Recheck immediately before each external effect. Socket consumers also
    // enforce the persisted revision and current grant, which is the final
    // delivery fence if a revocation commits after this check.
    if (!(await this.partnerDeliveryAllowed(event, this.pool))) {
      await this.suppressAndFinish(event);
      return;
    }
    await this.broker.publish(toEnvelope(event));
    if (event.event_type === "care.request.created") {
      if (!(await this.partnerDeliveryAllowed(event, this.pool))) {
        await this.suppressAndFinish(event);
        return;
      }
      await this.sendCareNotifications(event, this.pool);
    }
    await this.pool.query(
      `
        UPDATE outbox_events
        SET processed_at = now(), locked_at = NULL, locked_by = NULL, last_error = NULL
        WHERE id = $1 AND locked_by = $2
      `,
      [event.id, this.config.workerId],
    );
  }

  private async markDeliveryAuthorization(event: OutboxRow): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Consent/privacy mutations take an exclusive pair lock. This brief
      // shared lock makes the revision check and durable marker atomic without
      // holding a database transaction across Redis or push-provider I/O.
      await client.query("SELECT id FROM pairs WHERE id = $1 FOR SHARE", [
        event.pair_id,
      ]);
      const deliver = await this.partnerDeliveryAllowed(event, client);
      if (deliver) {
        await client.query(
          `
            UPDATE realtime_events
            SET delivery_authorized_at = COALESCE(delivery_authorized_at, now()),
                delivery_authorized_revision = $2
            WHERE event_uuid = $1 AND suppressed_at IS NULL
          `,
          [event.event_uuid, event.authorization_revision],
        );
      } else {
        await client.query(
          `
            UPDATE realtime_events
            SET suppressed_at = COALESCE(suppressed_at, now()),
                suppression_reason = COALESCE(suppression_reason, 'authorization_revoked_before_delivery'),
                delivery_authorized_at = NULL,
                delivery_authorized_revision = NULL
            WHERE event_uuid = $1
          `,
          [event.event_uuid],
        );
        await client.query(
          `
            UPDATE outbox_events
            SET processed_at = now(), locked_at = NULL, locked_by = NULL, last_error = NULL
            WHERE id = $1 AND locked_by = $2
          `,
          [event.id, this.config.workerId],
        );
      }
      await client.query("COMMIT");
      return deliver;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async suppressAndFinish(event: OutboxRow): Promise<void> {
    await this.pool.query(
      `
        WITH suppressed AS (
          UPDATE realtime_events
          SET suppressed_at = COALESCE(suppressed_at, now()),
              suppression_reason = COALESCE(suppression_reason, 'authorization_revision_changed'),
              delivery_authorized_at = NULL,
              delivery_authorized_revision = NULL
          WHERE event_uuid = $1
        )
        UPDATE outbox_events
        SET processed_at = now(), locked_at = NULL, locked_by = NULL, last_error = NULL
        WHERE id = $2 AND locked_by = $3
      `,
      [event.event_uuid, event.id, this.config.workerId],
    );
  }

  private async partnerDeliveryAllowed(
    event: OutboxRow,
    client: Pool | PoolClient,
  ): Promise<boolean> {
    if (
      event.event_type === "privacy.paused" ||
      event.event_type === "privacy.resumed" ||
      event.event_type === "pair.disconnected"
    ) {
      return true;
    }
    const requirement = directionalConsentForEvent({
      type: event.event_type,
      actorUserId: event.actor_user_id,
      ...(event.recipient_user_id
        ? { recipientUserId: event.recipient_user_id }
        : {}),
    });
    if (!requirement) return false;
    const result = await client.query<{ allowed: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM pairs p
          JOIN care_requests care
            ON care.id = $2 AND care.pair_id = p.id
            AND care.recipient_user_id = $3 AND care.sender_user_id = $4
            AND (
              $8::text <> 'care.request.created'
              OR (care.status = 'pending' AND care.expires_at > now())
            )
          JOIN consent_grants consent
            ON consent.pair_id = p.id
            AND consent.grantor_user_id = $3
            AND consent.grantee_user_id = $4
            AND consent.capability = $5
            AND consent.granted = true
            AND consent.updated_at <= $6
          WHERE p.id = $1 AND p.status = 'active'
            AND p.authorization_revision = $7
            AND (
              SELECT count(*) FROM pair_members member
              WHERE member.pair_id = p.id AND member.left_at IS NULL
            ) = 2
            AND NOT EXISTS (
              SELECT 1 FROM privacy_states privacy
              WHERE privacy.pair_id = p.id AND privacy.paused = true
            )
        ) AS allowed
      `,
      [
        event.pair_id,
        event.aggregate_id,
        requirement.grantorUserId,
        requirement.granteeUserId,
        requirement.capability,
        event.occurred_at,
        event.authorization_revision,
        event.event_type,
      ],
    );
    return result.rows[0]?.allowed === true;
  }

  private async sendCareNotifications(
    event: OutboxRow,
    client: Pool | PoolClient,
  ): Promise<void> {
    if (!event.recipient_user_id)
      throw new Error("Care event has no recipient");
    const careRequest = event.payload.careRequest;
    if (!careRequest || typeof careRequest !== "object")
      throw new Error("Care event has invalid payload");
    const fields = careRequest as Record<string, unknown>;
    if (typeof fields.id !== "string" || typeof fields.kind !== "string") {
      throw new Error("Care event payload is missing id or kind");
    }
    await client.query(
      `
        UPDATE notification_devices device
        SET disabled_at = COALESCE(device.disabled_at, now()), updated_at = now()
        WHERE device.user_id = $1 AND device.disabled_at IS NULL
          AND (
            device.expires_at <= now()
            OR NOT EXISTS (
              SELECT 1
              FROM auth_sessions session
              JOIN users owner ON owner.id = session.user_id
              WHERE session.family_id = device.session_family_id
                AND session.user_id = device.user_id
                AND session.client_platform = device.platform
                AND session.revoked_at IS NULL
                AND session.refresh_expires_at > now()
                AND owner.disabled_at IS NULL
            )
          )
      `,
      [event.recipient_user_id],
    );
    const devices = await client.query<DeviceRow>(
      `
        SELECT device.id::text, device.platform, device.token_ciphertext, delivery.status
        FROM notification_devices device
        LEFT JOIN notification_deliveries delivery
          ON delivery.device_id = device.id AND delivery.event_uuid = $2
        WHERE device.user_id = $1 AND device.disabled_at IS NULL
          AND device.expires_at > now()
          AND EXISTS (
            SELECT 1
            FROM auth_sessions session
            JOIN users owner ON owner.id = session.user_id
            WHERE session.family_id = device.session_family_id
              AND session.user_id = device.user_id
              AND session.client_platform = device.platform
              AND session.revoked_at IS NULL
              AND session.refresh_expires_at > now()
              AND owner.disabled_at IS NULL
          )
        ORDER BY device.updated_at DESC, device.id
        LIMIT 5
      `,
      [event.recipient_user_id, event.event_uuid],
    );
    for (const row of devices.rows) {
      if (row.status === "succeeded" || row.status === "permanent_failure")
        continue;
      await client.query(
        `
          INSERT INTO notification_deliveries(event_uuid, device_id, status)
          VALUES ($1, $2, 'pending')
          ON CONFLICT (event_uuid, device_id) DO NOTHING
        `,
        [event.event_uuid, row.id],
      );
      const device: NotificationDevice = {
        id: row.id,
        platform: row.platform,
        token: decryptDeviceToken(row.token_ciphertext, this.encryptionKey),
      };
      try {
        const result = await this.notifications.send(device, {
          eventId: event.event_uuid,
          careRequestId: fields.id,
          kind: fields.kind,
        });
        await client.query(
          `
            UPDATE notification_deliveries
            SET status = 'succeeded', attempts = attempts + 1,
                provider_message_id = $3, last_error = NULL, updated_at = now()
            WHERE event_uuid = $1 AND device_id = $2
          `,
          [event.event_uuid, row.id, result.providerMessageId ?? null],
        );
      } catch (error) {
        const permanent =
          error instanceof NotificationDeliveryError && error.permanent;
        await client.query(
          `
            UPDATE notification_deliveries
            SET status = $3, attempts = attempts + 1, last_error = $4, updated_at = now()
            WHERE event_uuid = $1 AND device_id = $2
          `,
          [
            event.event_uuid,
            row.id,
            permanent ? "permanent_failure" : "pending",
            error instanceof Error
              ? error.message.slice(0, 2_000)
              : "unknown push error",
          ],
        );
        if (
          permanent &&
          error instanceof NotificationDeliveryError &&
          error.invalidateDevice
        ) {
          await client.query(
            "UPDATE notification_devices SET disabled_at = now(), updated_at = now() WHERE id = $1",
            [row.id],
          );
        }
        if (permanent) continue;
        throw error;
      }
    }
  }
}

export function outboxBackoffMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 15 * 60 * 1_000);
}

function toEnvelope(event: OutboxRow): RealtimeEventEnvelope {
  const eventId = event.payload.eventId;
  if (typeof eventId !== "string")
    throw new Error("Outbox realtime payload is missing eventId");
  const { eventId: _eventId, ...payload } = event.payload;
  return realtimeEventEnvelopeSchema.parse({
    version: 1,
    id: event.event_uuid,
    eventId,
    authorizationRevision: event.authorization_revision,
    type: event.event_type,
    occurredAt: event.occurred_at.toISOString(),
    pairId: event.pair_id,
    payload,
  });
}

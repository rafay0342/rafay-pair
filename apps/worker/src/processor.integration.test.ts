import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  deriveDeviceEncryptionKey,
  encryptDeviceToken,
  NotificationDispatcher,
  type PushProvider,
} from "@rafay-pair/notifications";

import type { WorkerConfig } from "./config.js";
import { OutboxProcessor } from "./processor.js";

const schemaName = `rafay_worker_test_${crypto.randomUUID().replaceAll("-", "")}`;
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://rafay_pair:local-development-only@127.0.0.1:5432/rafay_pair?sslmode=disable";
const admin = new Pool({ connectionString: databaseUrl });
const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schemaName},public`,
});
const sessionPepper = "worker-integration-pepper-at-least-thirty-two-bytes";
const config = {
  nodeEnv: "test",
  databaseUrl,
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  sessionPepper,
  pollIntervalMs: 500,
  healthPort: 3_001,
  logLevel: "silent",
  workerId: `test:${process.pid}`,
  apns: undefined,
  fcm: undefined,
} as WorkerConfig;

beforeAll(async () => {
  await ensureTestExtensions();
  await admin.query(`CREATE SCHEMA ${schemaName}`);
  const migrations = await Promise.all(
    [
      "0001_foundation.sql",
      "0002_realtime_delivery_authorization.sql",
      "0003_notification_device_lifecycle.sql",
      "0004_care_expiry_index.sql",
    ].map(async (name) =>
      readFile(
        fileURLToPath(new URL(`../../api/migrations/${name}`, import.meta.url)),
        "utf8",
      ),
    ),
  );
  const migrationClient = await pool.connect();
  try {
    for (const migration of migrations) {
      if (/^\s*-- rafay-pair:no-transaction(?:\r?\n|$)/u.test(migration)) {
        await migrationClient.query(migration);
        continue;
      }
      await migrationClient.query("BEGIN");
      try {
        await migrationClient.query(migration);
        await migrationClient.query("COMMIT");
      } catch (error) {
        await migrationClient.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    migrationClient.release();
  }
});

afterAll(async () => {
  await pool.end().catch(() => undefined);
  await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await admin.end();
});

describe("transactional outbox worker", () => {
  it("publishes only with fresh directional consent and suppresses revoked or privacy-paused delivery", async () => {
    const senderId = crypto.randomUUID();
    const recipientId = crypto.randomUUID();
    const pairId = crypto.randomUUID();
    await pool.query(
      `
        INSERT INTO users(id, email, display_name, password_hash)
        VALUES ($1, 'sender@worker.test', 'Sender', 'hash'),
               ($2, 'recipient@worker.test', 'Recipient', 'hash')
      `,
      [senderId, recipientId],
    );
    await pool.query(
      "INSERT INTO pairs(id, created_by_user_id, status, activated_at) VALUES ($1, $2, 'active', now())",
      [pairId, senderId],
    );
    await pool.query(
      "INSERT INTO pair_members(pair_id, user_id) VALUES ($1, $2), ($1, $3)",
      [pairId, senderId, recipientId],
    );
    await pool.query(
      "INSERT INTO privacy_states(pair_id, user_id) VALUES ($1, $2), ($1, $3)",
      [pairId, senderId, recipientId],
    );
    await pool.query(
      `
        INSERT INTO consent_grants (
          pair_id, grantor_user_id, grantee_user_id, capability, granted
        ) VALUES ($1, $2, $3, 'care_requests', true)
      `,
      [pairId, recipientId, senderId],
    );

    const deviceId = crypto.randomUUID();
    const sessionFamilyId = crypto.randomUUID();
    await pool.query(
      `
        INSERT INTO auth_sessions(
          family_id, user_id, client_platform, access_token_hash,
          refresh_token_hash, access_expires_at, refresh_expires_at
        ) VALUES ($1, $2, 'android', $3, $4, now() + interval '15 minutes',
                  now() + interval '30 days')
      `,
      [sessionFamilyId, recipientId, "b".repeat(64), "c".repeat(64)],
    );
    const encryptionKey = deriveDeviceEncryptionKey(sessionPepper);
    await pool.query(
      `
        INSERT INTO notification_devices(
          id, user_id, platform, installation_id, session_family_id,
          token_hash, token_ciphertext
        )
        VALUES ($1, $2, 'android', $3, $4, $5, $6)
      `,
      [
        deviceId,
        recipientId,
        crypto.randomUUID(),
        sessionFamilyId,
        "a".repeat(64),
        encryptDeviceToken(
          "android-device-token-for-integration",
          encryptionKey,
        ),
      ],
    );

    const eventUuid = crypto.randomUUID();
    const careRequestId = crypto.randomUUID();
    await insertOutbox(eventUuid, pairId, senderId, recipientId, careRequestId);

    const published: unknown[] = [];
    const broker = { publish: async (event: unknown) => published.push(event) };
    const send = vi
      .fn<PushProvider["send"]>()
      .mockResolvedValue({ providerMessageId: "fcm-message-1" });
    const processor = new OutboxProcessor(
      pool,
      broker as never,
      new NotificationDispatcher(undefined, { send }),
      config,
      pino({ level: "silent" }),
    );
    await expect(processor.processAvailable()).resolves.toBe(1);
    await expect(processor.processAvailable()).resolves.toBe(0);
    expect(published).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    const delivery = await pool.query<{ status: string; attempts: number }>(
      "SELECT status, attempts FROM notification_deliveries WHERE event_uuid = $1 AND device_id = $2",
      [eventUuid, deviceId],
    );
    expect(delivery.rows[0]).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
    const authorized = await pool.query<{
      delivery_authorized_at: Date | null;
      delivery_authorized_revision: string | null;
    }>(
      "SELECT delivery_authorized_at, delivery_authorized_revision::text FROM realtime_events WHERE event_uuid = $1",
      [eventUuid],
    );
    expect(authorized.rows[0]?.delivery_authorized_at).toBeInstanceOf(Date);
    expect(authorized.rows[0]?.delivery_authorized_revision).toBe("0");

    const expiredUuid = crypto.randomUUID();
    const expiredCareRequestId = crypto.randomUUID();
    await insertOutbox(
      expiredUuid,
      pairId,
      senderId,
      recipientId,
      expiredCareRequestId,
    );
    await pool.query(
      "UPDATE care_requests SET expires_at = now() - interval '1 second' WHERE id = $1",
      [expiredCareRequestId],
    );
    await expect(processor.processAvailable()).resolves.toBe(1);
    expect(published).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    const expiredReplay = await pool.query<{ suppressed_at: Date | null }>(
      "SELECT suppressed_at FROM realtime_events WHERE event_uuid = $1",
      [expiredUuid],
    );
    expect(expiredReplay.rows[0]?.suppressed_at).toBeInstanceOf(Date);

    await pool.query(
      "UPDATE auth_sessions SET revoked_at = now(), revoke_reason = 'test_logout' WHERE family_id = $1",
      [sessionFamilyId],
    );
    const loggedOutUuid = crypto.randomUUID();
    await insertOutbox(
      loggedOutUuid,
      pairId,
      senderId,
      recipientId,
      crypto.randomUUID(),
    );
    await expect(processor.processAvailable()).resolves.toBe(1);
    expect(published).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(1);
    const loggedOutDevice = await pool.query<{ disabled_at: Date | null }>(
      "SELECT disabled_at FROM notification_devices WHERE id = $1",
      [deviceId],
    );
    expect(loggedOutDevice.rows[0]?.disabled_at).toBeInstanceOf(Date);

    await pool.query(
      `
        UPDATE consent_grants
        SET granted = false, updated_at = now()
        WHERE pair_id = $1 AND grantor_user_id = $2
          AND grantee_user_id = $3 AND capability = 'care_requests'
      `,
      [pairId, recipientId, senderId],
    );
    const revokedUuid = crypto.randomUUID();
    await insertOutbox(
      revokedUuid,
      pairId,
      senderId,
      recipientId,
      crypto.randomUUID(),
    );
    await expect(processor.processAvailable()).resolves.toBe(1);
    expect(published).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(1);
    const revoked = await pool.query<{
      suppressed_at: Date | null;
      delivery_authorized_at: Date | null;
    }>(
      "SELECT suppressed_at, delivery_authorized_at FROM realtime_events WHERE event_uuid = $1",
      [revokedUuid],
    );
    expect(revoked.rows[0]?.suppressed_at).toBeInstanceOf(Date);
    expect(revoked.rows[0]?.delivery_authorized_at).toBeNull();

    await pool.query(
      `
        UPDATE consent_grants
        SET granted = true, updated_at = now()
        WHERE pair_id = $1 AND grantor_user_id = $2
          AND grantee_user_id = $3 AND capability = 'care_requests'
      `,
      [pairId, recipientId, senderId],
    );

    await pool.query(
      "UPDATE privacy_states SET paused = true, paused_at = now() WHERE pair_id = $1 AND user_id = $2",
      [pairId, senderId],
    );
    const suppressedUuid = crypto.randomUUID();
    await insertOutbox(
      suppressedUuid,
      pairId,
      senderId,
      recipientId,
      crypto.randomUUID(),
    );
    await expect(processor.processAvailable()).resolves.toBe(1);
    expect(published).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(1);
    const suppressed = await pool.query<{ processed_at: Date | null }>(
      "SELECT processed_at FROM outbox_events WHERE event_uuid = $1",
      [suppressedUuid],
    );
    expect(suppressed.rows[0]?.processed_at).toBeInstanceOf(Date);
    const replayState = await pool.query<{ suppressed_at: Date | null }>(
      "SELECT suppressed_at FROM realtime_events WHERE event_uuid = $1",
      [suppressedUuid],
    );
    expect(replayState.rows[0]?.suppressed_at).toBeInstanceOf(Date);
  });
});

async function insertOutbox(
  eventUuid: string,
  pairId: string,
  senderId: string,
  recipientId: string,
  careRequestId: string,
): Promise<void> {
  const realtime = await pool.query<{ id: string }>(
    `
      INSERT INTO realtime_events(
        event_uuid, pair_id, event_type, payload, authorization_revision
      )
      SELECT $1, $2, 'care.request.created', '{}', authorization_revision
      FROM pairs WHERE id = $2
      RETURNING id::text
    `,
    [eventUuid, pairId],
  );
  const eventId = realtime.rows[0]?.id;
  if (!eventId) throw new Error("Realtime fixture insert returned no id");
  await pool.query(
    `
      INSERT INTO care_requests (
        id, client_request_id, pair_id, sender_user_id, recipient_user_id, kind
      ) VALUES ($1, $2, $3, $4, $5, 'check_in')
    `,
    [careRequestId, crypto.randomUUID(), pairId, senderId, recipientId],
  );
  await pool.query(
    `
      INSERT INTO outbox_events (
        event_uuid, event_type, aggregate_type, aggregate_id, pair_id,
        actor_user_id, recipient_user_id, payload, occurred_at, authorization_revision
      )
      SELECT $1, 'care.request.created', 'care_request', $5, $2, $3, $4, $6, now(),
             authorization_revision
      FROM pairs WHERE id = $2
    `,
    [
      eventUuid,
      pairId,
      senderId,
      recipientId,
      careRequestId,
      {
        eventId,
        actorUserId: senderId,
        recipientUserId: recipientId,
        careRequest: {
          id: careRequestId,
          clientRequestId: crypto.randomUUID(),
          pairId,
          senderUserId: senderId,
          recipientUserId: recipientId,
          kind: "check_in",
          status: "pending",
          createdAt: new Date().toISOString(),
        },
      },
    ],
  );
}

async function ensureTestExtensions(): Promise<void> {
  await admin.query(
    "SELECT pg_advisory_lock(hashtext('rafay_pair_test_extensions'))",
  );
  try {
    await admin.query(
      "CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public",
    );
    await admin.query(
      "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public",
    );
  } finally {
    await admin.query(
      "SELECT pg_advisory_unlock(hashtext('rafay_pair_test_extensions'))",
    );
  }
}

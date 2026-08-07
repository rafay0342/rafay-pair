import type { Pool, PoolClient } from "pg";

import type { AndroidIntegrityAction } from "@rafay-pair/api-contracts";

import { withTransaction } from "./database.js";
import { ApiError } from "./errors.js";
import type { AuthContext, ClientPlatform } from "./types.js";

const challengeLifetimeMilliseconds = 2 * 60 * 1_000;
const maximumChallengesPerFamilyPerHour = 10;
const maximumOutstandingChallengesPerFamily = 3;

export interface DeviceIntegrityChallenge {
  id: string;
  action: string;
  expiresAt: Date;
}

export async function issueDeviceIntegrityChallenge(
  pool: Pool,
  auth: AuthContext,
  platform: Exclude<ClientPlatform, "web">,
  action: AndroidIntegrityAction | string,
  onIssued?: (
    client: PoolClient,
    challenge: DeviceIntegrityChallenge,
  ) => Promise<void>,
): Promise<DeviceIntegrityChallenge> {
  return withTransaction(pool, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 41))",
      [`${platform}:${auth.familyId}`],
    );
    await client.query(
      `
        DELETE FROM device_integrity_challenges
        WHERE consumed_at IS NULL
          AND expires_at < now() - interval '1 day'
      `,
    );
    const recent = await client.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM device_integrity_challenges
        WHERE session_family_id = $1
          AND platform = $2
          AND created_at > now() - interval '1 hour'
      `,
      [auth.familyId, platform],
    );
    if (
      Number(recent.rows[0]?.count ?? 0) >= maximumChallengesPerFamilyPerHour
    ) {
      throw new ApiError(
        429,
        "INTEGRITY_RATE_LIMITED",
        "Integrity checks are temporarily limited",
        "Wait before requesting another device integrity check.",
      );
    }
    const outstanding = await client.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM device_integrity_challenges
        WHERE session_family_id = $1
          AND platform = $2
          AND consumed_at IS NULL
          AND expires_at > now()
      `,
      [auth.familyId, platform],
    );
    if (
      Number(outstanding.rows[0]?.count ?? 0) >=
      maximumOutstandingChallengesPerFamily
    ) {
      throw new ApiError(
        429,
        "INTEGRITY_CHALLENGE_LIMIT_REACHED",
        "Too many integrity checks are pending",
        "Complete or allow an earlier device integrity check to expire.",
      );
    }
    const result = await client.query<{
      id: string;
      action: string;
      expires_at: Date;
    }>(
      `
        INSERT INTO device_integrity_challenges(
          user_id, session_family_id, platform, action, expires_at
        ) VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 millisecond'))
        RETURNING id, action, expires_at
      `,
      [
        auth.userId,
        auth.familyId,
        platform,
        action,
        challengeLifetimeMilliseconds,
      ],
    );
    const row = result.rows[0];
    if (!row)
      throw new Error("Device integrity challenge insert returned no row");
    const challenge = {
      id: row.id,
      action: row.action,
      expiresAt: row.expires_at,
    };
    if (onIssued) await onIssued(client, challenge);
    return challenge;
  });
}

export async function consumeDeviceIntegrityChallenge(
  pool: Pool,
  auth: AuthContext,
  input: {
    id: string;
    platform: Exclude<ClientPlatform, "web">;
    action: string;
  },
  beforeConsume?: (
    client: PoolClient,
    challenge: DeviceIntegrityChallenge,
  ) => Promise<void>,
): Promise<DeviceIntegrityChallenge> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<{
      id: string;
      action: string;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `
        SELECT id, action, expires_at, consumed_at
        FROM device_integrity_challenges
        WHERE id = $1
          AND user_id = $2
          AND session_family_id = $3
          AND platform = $4
        FOR UPDATE
      `,
      [input.id, auth.userId, auth.familyId, input.platform],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ApiError(
        404,
        "INTEGRITY_CHALLENGE_NOT_FOUND",
        "Integrity challenge not found",
      );
    }
    if (
      row.action !== input.action ||
      row.consumed_at !== null ||
      row.expires_at <= new Date()
    ) {
      throw new ApiError(
        409,
        "INTEGRITY_CHALLENGE_UNAVAILABLE",
        "Integrity challenge is no longer available",
        "Request a new device integrity challenge.",
      );
    }
    const challenge = {
      id: row.id,
      action: row.action,
      expiresAt: row.expires_at,
    };
    if (beforeConsume) await beforeConsume(client, challenge);
    await client.query(
      "UPDATE device_integrity_challenges SET consumed_at = now() WHERE id = $1",
      [row.id],
    );
    return challenge;
  });
}

export async function recordDeviceIntegrityAssessment(
  database: Pool | PoolClient,
  input: {
    challengeId: string;
    auth: AuthContext;
    platform: Exclude<ClientPlatform, "web">;
    provider: "play_integrity" | "app_attest";
    signal: "low_risk" | "elevated_risk" | "invalid_binding";
    bindingValid: boolean;
    providerMetadata: Record<string, unknown>;
  },
): Promise<{ id: string; evaluatedAt: Date }> {
  const serializedMetadata = JSON.stringify(input.providerMetadata);
  if (Buffer.byteLength(serializedMetadata, "utf8") > 4_096) {
    throw new Error("Sanitized device integrity metadata exceeds 4096 bytes");
  }
  const result = await database.query<{ id: string; evaluated_at: Date }>(
    `
      INSERT INTO device_integrity_assessments(
        challenge_id, user_id, session_family_id, platform, provider,
        signal, binding_valid, provider_metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      RETURNING id, evaluated_at
    `,
    [
      input.challengeId,
      input.auth.userId,
      input.auth.familyId,
      input.platform,
      input.provider,
      input.signal,
      input.bindingValid,
      serializedMetadata,
    ],
  );
  const row = result.rows[0];
  if (!row)
    throw new Error("Device integrity assessment insert returned no row");
  return { id: row.id, evaluatedAt: row.evaluated_at };
}

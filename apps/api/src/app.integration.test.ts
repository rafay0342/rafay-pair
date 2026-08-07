import { fileURLToPath } from "node:url";
import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createRedisClient,
  RealtimeConnectionLeaseStore,
  RealtimeTicketStore,
  type TicketStoreClient,
} from "@rafay-pair/realtime";
import type { RealtimeEventEnvelope } from "@rafay-pair/api-contracts";

import { buildApi } from "./app.js";
import { hashAppAttestKeyId } from "./app-attest.js";
import type { ApiConfig } from "./config.js";
import { runMigrations } from "./database.js";
import {
  createPlayIntegrityRequestHash,
  PlayIntegrityProviderError,
  type PlayIntegrityVerifier,
} from "./play-integrity.js";

class MemoryTicketClient implements TicketStoreClient {
  private readonly values = new Map<string, string>();

  public async sendCommand(
    command: readonly string[],
  ): Promise<string | number | null> {
    if (command[0] === "EVAL") {
      const key = command[3];
      const value = command[6];
      if (!key || !value || this.values.has(key)) return 0;
      this.values.set(key, value);
      return 1;
    }
    const key = command[1];
    if (!key) return null;
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }
}

const schemaName = `rafay_test_${crypto.randomUUID().replaceAll("-", "")}`;
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://rafay_pair:local-development-only@127.0.0.1:5432/rafay_pair?sslmode=disable";
const testRedisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const admin = new Pool({ connectionString: databaseUrl });
const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schemaName},public`,
});
const published: unknown[] = [];
const subscribers = new Map<
  string,
  Set<(event: RealtimeEventEnvelope) => void>
>();
const realtimeBroker = {
  publish: async (event: RealtimeEventEnvelope) => {
    published.push(event);
    for (const listener of subscribers.get(event.pairId) ?? []) listener(event);
  },
  subscribe: async (
    pairId: string,
    listener: (event: RealtimeEventEnvelope) => void,
  ) => {
    const listeners = subscribers.get(pairId) ?? new Set();
    listeners.add(listener);
    subscribers.set(pairId, listeners);
    return async () => {
      listeners.delete(listener);
      if (listeners.size === 0) subscribers.delete(pairId);
    };
  },
  close: async () => undefined,
};
const config: ApiConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3_000,
  publicApiUrl: "http://localhost:3000",
  publicWebOrigin: "http://localhost:4173",
  allowedOrigins: ["http://localhost:4173"],
  databaseUrl,
  redisUrl: testRedisUrl,
  realtimeMaxConnectionsPerUser: 4,
  realtimeMaxConnectionsPerSession: 2,
  realtimeConnectionLeaseTtlSeconds: 45,
  realtimeMaxTicketsPerUserWindow: 12,
  realtimeMaxTicketsPerSessionWindow: 6,
  realtimeReplayPageSize: 100,
  realtimeMaxBufferedEvents: 1_000,
  realtimeMaxSocketBufferBytes: 1_048_576,
  sessionPepper: "integration-session-pepper-at-least-thirty-two-bytes",
  joinCodePepper: "integration-join-pepper-at-least-thirty-two-bytes",
  playIntegrity: {
    packageName: "com.rafaypair.android",
    googleCredentials: {
      type: "service_account",
      client_email: "integration@example.test",
      private_key: "integration-test-only",
    },
    allowedCertificateSha256Digests: ["a".repeat(43)],
    minimumVersionCode: 1,
    providerTimeoutMs: 8_000,
    maxTokenAgeMs: 120_000,
  },
  appAttest: {
    appId: "ABCDEFGHIJ.com.rafaypair.app",
    environment: "production",
    allowedValidationCategories: new Set([1]),
    allowedBundleVersions: new Set(["1"]),
  },
  trustProxy: false,
  logLevel: "silent",
};
const playIntegrityVerifier: PlayIntegrityVerifier = {
  async decode(integrityToken) {
    if (integrityToken.startsWith("provider-unavailable.")) {
      throw new PlayIntegrityProviderError("provider_unavailable");
    }
    const requestHash = integrityToken.split(".")[1] ?? "missing";
    return {
      tokenPayloadExternal: {
        requestDetails: {
          requestPackageName: "com.rafaypair.android",
          requestHash,
          timestampMillis: String(Date.now()),
        },
        appIntegrity: {
          appRecognitionVerdict: "PLAY_RECOGNIZED",
          packageName: "com.rafaypair.android",
          versionCode: "42",
          certificateSha256Digest: ["a".repeat(43)],
        },
        accountDetails: { appLicensingVerdict: "LICENSED" },
        deviceIntegrity: {
          deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"],
        },
        testingDetails: { isTestingResponse: false },
      },
    };
  },
};
const realtimeStateRedis = createRedisClient(config.redisUrl);

let app: Awaited<ReturnType<typeof buildApi>>;
let registrationAddress = 10;
let realtimeSocketUrl: string;

beforeAll(async () => {
  await ensureTestExtensions();
  await realtimeStateRedis.connect();
  await admin.query(`CREATE SCHEMA ${schemaName}`);
  const migrationsDirectory = fileURLToPath(
    new URL("../migrations", import.meta.url),
  );
  await runMigrations(pool, migrationsDirectory);
  await runMigrations(pool, migrationsDirectory);
  app = await buildApi({
    config,
    pool,
    realtimeBroker: realtimeBroker as never,
    ticketStore: new RealtimeTicketStore(new MemoryTicketClient()),
    connectionLeaseStore: new RealtimeConnectionLeaseStore(realtimeStateRedis, {
      ttlSeconds: config.realtimeConnectionLeaseTtlSeconds,
      maxConnectionsPerUser: config.realtimeMaxConnectionsPerUser,
      maxConnectionsPerSession: config.realtimeMaxConnectionsPerSession,
    }),
    playIntegrityVerifier,
  });
  await app.ready();
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  realtimeSocketUrl = `${address.replace(/^http/u, "ws")}/v1/realtime`;
});

afterAll(async () => {
  await app?.close();
  if (realtimeStateRedis.isOpen) await realtimeStateRedis.close();
  await pool.end().catch(() => undefined);
  await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await admin.end();
});

describe("Milestone 1 API", () => {
  it("serves both direct and CloudFront-prefixed health routes", async () => {
    for (const url of [
      "/health/live",
      "/health/ready",
      "/v1/health/live",
      "/v1/health/ready",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toMatch(/^(?:ok|ready)$/u);
    }
  });

  it("records unsupported App Attest as risk telemetry and consumes its challenge once", async () => {
    const ios = await registerNative(
      "integrity-ios-unsupported@example.test",
      "IntegrityIosUnsupported",
      "ios",
    );
    const challengeResponse = await app.inject({
      method: "POST",
      url: "/v1/integrity/ios/challenges",
      headers: nativeHeaders(ios.accessToken, "ios"),
      payload: { action: "session_start", supported: false },
    });
    expect(challengeResponse.statusCode).toBe(201);
    const challenge = challengeResponse.json().challenge as {
      id: string;
      mode: string;
      clientData: string;
    };
    expect(challenge.mode).toBe("unsupported");
    expect(challenge.clientData).toMatch(/^[A-Za-z0-9_-]+$/u);

    const submission = {
      challengeId: challenge.id,
      action: "session_start",
      mode: "unsupported",
    };
    const assessment = await app.inject({
      method: "POST",
      url: "/v1/integrity/ios/assessments",
      headers: nativeHeaders(ios.accessToken, "ios"),
      payload: submission,
    });
    expect(assessment.statusCode).toBe(202);
    expect(assessment.json().assessment.signal).toBe("elevated_risk");

    const replay = await app.inject({
      method: "POST",
      url: "/v1/integrity/ios/assessments",
      headers: nativeHeaders(ios.accessToken, "ios"),
      payload: submission,
    });
    expect(replay.statusCode).toBe(409);
  });

  it("sanitizes an invalid App Attest proof into telemetry without registering a key", async () => {
    const ios = await registerNative(
      "integrity-ios-invalid@example.test",
      "IntegrityIosInvalid",
      "ios",
    );
    const keyId = Buffer.alloc(32, 11).toString("base64");
    const challengeResponse = await app.inject({
      method: "POST",
      url: "/v1/integrity/ios/challenges",
      headers: nativeHeaders(ios.accessToken, "ios"),
      payload: { action: "session_start", supported: true, keyId },
    });
    expect(challengeResponse.statusCode).toBe(201);
    const challenge = challengeResponse.json().challenge as {
      id: string;
      mode: string;
    };
    expect(challenge.mode).toBe("attestation");

    const proof = Buffer.alloc(96, 5).toString("base64");
    const assessment = await app.inject({
      method: "POST",
      url: "/v1/integrity/ios/assessments",
      headers: nativeHeaders(ios.accessToken, "ios"),
      payload: {
        challengeId: challenge.id,
        action: "session_start",
        mode: "attestation",
        keyId,
        attestationObject: proof,
      },
    });
    expect(assessment.statusCode).toBe(202);
    expect(assessment.json().assessment.signal).toBe("invalid_binding");

    const stored = await pool.query<{
      provider_metadata: Record<string, unknown>;
      keys: string;
    }>(
      `
        SELECT a.provider_metadata,
               (SELECT count(*)::text FROM app_attest_keys) AS keys
        FROM device_integrity_assessments a
        WHERE a.challenge_id = $1
      `,
      [challenge.id],
    );
    expect(stored.rows[0]?.keys).toBe("0");
    expect(stored.rows[0]?.provider_metadata).toEqual({
      providerResult: "verification_failed",
      proofType: "attestation",
    });
    expect(JSON.stringify(stored.rows[0])).not.toContain(keyId);
    expect(JSON.stringify(stored.rows[0])).not.toContain(proof);
  });

  it("advances an App Attest assertion counter once and rejects a repeated counter", async () => {
    const ios = await registerNative(
      "integrity-ios-counter@example.test",
      "IntegrityIosCounter",
      "ios",
    );
    const keyId = Buffer.alloc(32, 19).toString("base64");
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    await pool.query(
      `
        INSERT INTO app_attest_keys(
          user_id, key_id_hash, environment, public_key_spki, receipt
        ) VALUES ($1, $2, 'production', $3, $4)
      `,
      [
        ios.userId,
        hashAppAttestKeyId(keyId),
        publicKey.export({ type: "spki", format: "der" }),
        Buffer.alloc(64, 1),
      ],
    );

    const firstChallenge = await issueIosAssertionChallenge(
      ios.accessToken,
      keyId,
    );
    const firstAssertion = createTestAppAttestAssertion(
      firstChallenge.clientData,
      1,
      privateKey,
    );
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/integrity/ios/assessments",
      headers: nativeHeaders(ios.accessToken, "ios"),
      payload: {
        challengeId: firstChallenge.id,
        action: "session_start",
        mode: "assertion",
        keyId,
        assertionObject: firstAssertion,
      },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().assessment.signal).toBe("elevated_risk");

    const repeatedChallenge = await issueIosAssertionChallenge(
      ios.accessToken,
      keyId,
    );
    const repeatedCounter = await app.inject({
      method: "POST",
      url: "/v1/integrity/ios/assessments",
      headers: nativeHeaders(ios.accessToken, "ios"),
      payload: {
        challengeId: repeatedChallenge.id,
        action: "session_start",
        mode: "assertion",
        keyId,
        assertionObject: createTestAppAttestAssertion(
          repeatedChallenge.clientData,
          1,
          privateKey,
        ),
      },
    });
    expect(repeatedCounter.statusCode).toBe(202);
    expect(repeatedCounter.json().assessment.signal).toBe("invalid_binding");
    const storedCounter = await pool.query<{ sign_count: string }>(
      "SELECT sign_count::text FROM app_attest_keys WHERE key_id_hash = $1",
      [hashAppAttestKeyId(keyId)],
    );
    expect(storedCounter.rows[0]?.sign_count).toBe("1");
  });

  it("records a one-time content-bound Android integrity risk signal without storing the token", async () => {
    const android = await registerNative(
      "integrity-android@example.test",
      "IntegrityAndroid",
      "android",
    );
    const challengeResponse = await app.inject({
      method: "POST",
      url: "/v1/integrity/android/challenges",
      headers: nativeHeaders(android.accessToken, "android"),
      payload: { action: "session_start" },
    });
    expect(challengeResponse.statusCode).toBe(201);
    const challenge = challengeResponse.json().challenge as {
      id: string;
      bindingVersion: string;
    };
    expect(challenge.bindingVersion).toBe("sha256-v1");
    const requestHash = createPlayIntegrityRequestHash(
      challenge.id,
      "session_start",
    );
    const opaqueToken = `provider.${requestHash}.${"x".repeat(64)}`;
    const assessment = await app.inject({
      method: "POST",
      url: "/v1/integrity/android/assessments",
      headers: nativeHeaders(android.accessToken, "android"),
      payload: {
        challengeId: challenge.id,
        action: "session_start",
        integrityToken: opaqueToken,
      },
    });
    expect(assessment.statusCode).toBe(202);
    expect(assessment.json().assessment.signal).toBe("low_risk");

    const stored = await pool.query<{
      provider: string;
      signal: string;
      provider_metadata: Record<string, unknown>;
    }>(
      `
        SELECT provider, signal, provider_metadata
        FROM device_integrity_assessments
        WHERE user_id = $1
      `,
      [android.userId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      provider: "play_integrity",
      signal: "low_risk",
    });
    expect(JSON.stringify(stored.rows[0])).not.toContain(opaqueToken);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/integrity/android/assessments",
      headers: nativeHeaders(android.accessToken, "android"),
      payload: {
        challengeId: challenge.id,
        action: "session_start",
        integrityToken: opaqueToken,
      },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().code).toBe("INTEGRITY_CHALLENGE_UNAVAILABLE");
  });

  it("rejects Android integrity routes from a non-Android session", async () => {
    const ios = await registerNative(
      "integrity-ios@example.test",
      "IntegrityIos",
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/integrity/android/challenges",
      headers: nativeHeaders(ios.accessToken),
      payload: { action: "session_start" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("PLATFORM_MISMATCH");
  });

  it("fails closed and audits a sanitized provider outage after consuming the challenge", async () => {
    const android = await registerNative(
      "integrity-provider-error@example.test",
      "IntegrityProviderError",
      "android",
    );
    const challengeResponse = await app.inject({
      method: "POST",
      url: "/v1/integrity/android/challenges",
      headers: nativeHeaders(android.accessToken, "android"),
      payload: { action: "session_start" },
    });
    expect(challengeResponse.statusCode).toBe(201);
    const challengeId = challengeResponse.json().challenge.id as string;
    const opaqueToken = `provider-unavailable.${"x".repeat(64)}`;
    const submission = {
      challengeId,
      action: "session_start" as const,
      integrityToken: opaqueToken,
    };
    const unavailable = await app.inject({
      method: "POST",
      url: "/v1/integrity/android/assessments",
      headers: nativeHeaders(android.accessToken, "android"),
      payload: submission,
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({
      code: "PLAY_INTEGRITY_UNAVAILABLE",
      title: "Device integrity check is temporarily unavailable",
    });

    const audit = await pool.query<{
      metadata: Record<string, unknown>;
      target_id: string;
    }>(
      `
        SELECT metadata, target_id
        FROM security_audit_log
        WHERE actor_user_id = $1
          AND action = 'device_integrity.android.provider_error'
      `,
      [android.userId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      target_id: challengeId,
      metadata: {
        provider: "play_integrity",
        reason: "provider_unavailable",
      },
    });
    expect(JSON.stringify(audit.rows[0])).not.toContain(opaqueToken);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/integrity/android/assessments",
      headers: nativeHeaders(android.accessToken, "android"),
      payload: submission,
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().code).toBe("INTEGRITY_CHALLENGE_UNAVAILABLE");
  });

  it("records the retry-safe concurrent care expiry index exactly once", async () => {
    const index = await pool.query<{
      indexdef: string;
      indisvalid: boolean;
      indisready: boolean;
      indislive: boolean;
    }>(
      `
        SELECT pg_get_indexdef(indexrelid) AS indexdef,
               indisvalid,
               indisready,
               indislive
        FROM pg_index
        WHERE indexrelid = 'care_requests_pending_expiry_idx'::regclass
      `,
    );
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0]?.indexdef).toMatch(
      /USING btree \(pair_id, expires_at\) WHERE \(status = 'pending'::text\)$/u,
    );
    expect(index.rows[0]).toMatchObject({
      indisvalid: true,
      indisready: true,
      indislive: true,
    });
    const ledger = await pool.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM schema_migrations
        WHERE version IN (
          '0004_care_expiry_index.sql',
          '0006_repair_care_expiry_index.sql'
        )
      `,
    );
    expect(ledger.rows[0]?.count).toBe("2");
  });

  it("enforces authentication, two-person pairing, default-deny consent, care, pause, and revocation", async () => {
    const alice = await registerNative("alice@example.test", "Alice");
    const bob = await registerNative("bob@example.test", "Bob");

    const created = await app.inject({
      method: "POST",
      url: "/v1/pairs/current",
      headers: nativeHeaders(alice.accessToken),
    });
    expect(created.statusCode).toBe(201);
    const waitingPair = created.json().pair as {
      id: string;
      joinCode: string;
      members: unknown[];
    };
    expect(waitingPair.members).toHaveLength(1);
    expect(waitingPair.joinCode).toMatch(/^[A-Z2-9]{8}$/);

    const joined = await app.inject({
      method: "POST",
      url: "/v1/pairs/join",
      headers: nativeHeaders(bob.accessToken),
      payload: { code: waitingPair.joinCode },
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json().pair.members).toHaveLength(2);

    const defaultConsents = await app.inject({
      method: "GET",
      url: "/v1/consents",
      headers: nativeHeaders(bob.accessToken),
    });
    expect(defaultConsents.statusCode).toBe(200);
    expect(defaultConsents.json().grants).toHaveLength(7);
    expect(
      defaultConsents
        .json()
        .grants.every((grant: { granted: boolean }) => !grant.granted),
    ).toBe(true);

    const carePayload = {
      clientRequestId: crypto.randomUUID(),
      kind: "check_in",
      message: "How are you feeling?",
    };
    const denied = await app.inject({
      method: "POST",
      url: "/v1/care-requests",
      headers: nativeHeaders(alice.accessToken),
      payload: carePayload,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.headers["content-type"]).toContain(
      "application/problem+json",
    );
    expect(denied.json().code).toBe("CONSENT_DENIED");

    const grant = await app.inject({
      method: "PUT",
      url: "/v1/consents",
      headers: nativeHeaders(bob.accessToken),
      payload: { grants: [{ capability: "care_requests", granted: true }] },
    });
    expect(grant.statusCode).toBe(200);

    const sent = await app.inject({
      method: "POST",
      url: "/v1/care-requests",
      headers: nativeHeaders(alice.accessToken),
      payload: carePayload,
    });
    expect(sent.statusCode).toBe(201);
    const careRequest = sent.json().careRequest as { id: string };

    const retried = await app.inject({
      method: "POST",
      url: "/v1/care-requests",
      headers: nativeHeaders(alice.accessToken),
      payload: carePayload,
    });
    expect(retried.statusCode).toBe(201);
    expect(retried.json().careRequest.id).toBe(careRequest.id);

    const concurrentRequestId = crypto.randomUUID();
    const concurrentPayload = {
      clientRequestId: concurrentRequestId,
      kind: "encouragement",
    };
    const [concurrentLeft, concurrentRight] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/care-requests",
        headers: nativeHeaders(alice.accessToken),
        payload: concurrentPayload,
      }),
      app.inject({
        method: "POST",
        url: "/v1/care-requests",
        headers: nativeHeaders(alice.accessToken),
        payload: concurrentPayload,
      }),
    ]);
    expect(concurrentLeft.statusCode).toBe(201);
    expect(concurrentRight.statusCode).toBe(201);
    expect(concurrentLeft.json().careRequest.id).toBe(
      concurrentRight.json().careRequest.id,
    );
    const concurrentRows = await pool.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM care_requests
        WHERE sender_user_id = $1 AND client_request_id = $2
      `,
      [alice.userId, concurrentRequestId],
    );
    expect(concurrentRows.rows[0]?.count).toBe("1");

    const responded = await app.inject({
      method: "POST",
      url: `/v1/care-requests/${careRequest.id}/respond`,
      headers: nativeHeaders(bob.accessToken),
      payload: { response: "accepted" },
    });
    expect(responded.statusCode).toBe(200);
    expect(responded.json().careRequest.status).toBe("accepted");

    const paused = await app.inject({
      method: "POST",
      url: "/v1/privacy/pause",
      headers: nativeHeaders(alice.accessToken),
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().privacy.paused).toBe(true);
    const privacy = await app.inject({
      method: "GET",
      url: "/v1/privacy",
      headers: nativeHeaders(alice.accessToken),
    });
    expect(privacy.json().privacy.paused).toBe(true);

    const blockedByPause = await app.inject({
      method: "POST",
      url: "/v1/care-requests",
      headers: nativeHeaders(alice.accessToken),
      payload: { ...carePayload, clientRequestId: crypto.randomUUID() },
    });
    expect(blockedByPause.statusCode).toBe(403);
    expect(blockedByPause.json().code).toBe("PRIVACY_PAUSED");

    const resumed = await app.inject({
      method: "POST",
      url: "/v1/privacy/resume",
      headers: nativeHeaders(alice.accessToken),
    });
    expect(resumed.statusCode).toBe(200);

    const disconnected = await app.inject({
      method: "DELETE",
      url: "/v1/pairs/current",
      headers: nativeHeaders(bob.accessToken),
    });
    expect(disconnected.statusCode).toBe(204);
    const afterDisconnect = await app.inject({
      method: "POST",
      url: "/v1/care-requests",
      headers: nativeHeaders(alice.accessToken),
      payload: { ...carePayload, clientRequestId: crypto.randomUUID() },
    });
    expect(afterDisconnect.statusCode).toBe(409);
    expect(afterDisconnect.json().code).toBe("PAIR_REQUIRED");
    expect(published).toHaveLength(3); // pause, resume, and disconnect control events publish immediately.

    const rotated = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { "x-rafay-client": "ios" },
      payload: { refreshToken: alice.refreshToken },
    });
    expect(rotated.statusCode).toBe(200);
    const rotatedAccessToken = rotated.json().session.accessToken as string;
    const reuse = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { "x-rafay-client": "ios" },
      payload: { refreshToken: alice.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
    const familyRevoked = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: nativeHeaders(rotatedAccessToken),
    });
    expect(familyRevoked.statusCode).toBe(401);
  });

  it("expires stale care rows on read and paginates equal timestamps without loss", async () => {
    const sender = await registerNative(
      "care-page-a@example.test",
      "Care Page A",
    );
    const recipient = await registerNative(
      "care-page-b@example.test",
      "Care Page B",
    );
    const createdPair = await app.inject({
      method: "POST",
      url: "/v1/pairs/current",
      headers: nativeHeaders(sender.accessToken),
    });
    const pair = createdPair.json().pair as { id: string; joinCode: string };
    const joined = await app.inject({
      method: "POST",
      url: "/v1/pairs/join",
      headers: nativeHeaders(recipient.accessToken),
      payload: { code: pair.joinCode },
    });
    expect(joined.statusCode).toBe(200);
    const granted = await app.inject({
      method: "PUT",
      url: "/v1/consents",
      headers: nativeHeaders(recipient.accessToken),
      payload: { grants: [{ capability: "care_requests", granted: true }] },
    });
    expect(granted.statusCode).toBe(200);

    const ids: string[] = [];
    for (const kind of ["check_in", "encouragement", "help"]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/care-requests",
        headers: nativeHeaders(sender.accessToken),
        payload: { clientRequestId: crypto.randomUUID(), kind },
      });
      expect(response.statusCode).toBe(201);
      ids.push(response.json().careRequest.id as string);
    }
    await pool.query(
      `
        UPDATE care_requests
        SET created_at = '2026-01-01T00:00:00.000Z'
        WHERE pair_id = $1
      `,
      [pair.id],
    );
    await pool.query(
      "UPDATE care_requests SET expires_at = now() - interval '1 second' WHERE id = $1",
      [ids[0]],
    );

    const firstPage = await app.inject({
      method: "GET",
      url: "/v1/care-requests?limit=2",
      headers: nativeHeaders(recipient.accessToken),
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().items).toHaveLength(2);
    expect(firstPage.json().nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    const secondPage = await app.inject({
      method: "GET",
      url: `/v1/care-requests?limit=2&cursor=${encodeURIComponent(
        firstPage.json().nextCursor as string,
      )}`,
      headers: nativeHeaders(recipient.accessToken),
    });
    expect(secondPage.statusCode, secondPage.body).toBe(200);
    expect(secondPage.json().items).toHaveLength(1);
    const listed = [...firstPage.json().items, ...secondPage.json().items] as {
      id: string;
      status: string;
    }[];
    expect(new Set(listed.map((item) => item.id))).toEqual(new Set(ids));
    expect(listed.find((item) => item.id === ids[0])?.status).toBe("expired");

    const invalidCursor = await app.inject({
      method: "GET",
      url: "/v1/care-requests?cursor=not-a-valid-cursor",
      headers: nativeHeaders(recipient.accessToken),
    });
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json().code).toBe("VALIDATION_FAILED");
  });

  it("keeps Web credentials HttpOnly and rejects a missing CSRF proof", async () => {
    const csrf = await app.inject({
      method: "GET",
      url: "/v1/auth/csrf",
      headers: { "x-rafay-client": "web" },
    });
    const csrfCookie = cookieFrom(csrf.headers["set-cookie"], "rafay_csrf");
    const csrfToken = csrf.json().csrfToken as string;
    const registered = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      headers: {
        "x-rafay-client": "web",
        "x-csrf-token": csrfToken,
        origin: "http://localhost:4173",
        cookie: csrfCookie,
      },
      payload: {
        email: "web@example.test",
        password: "web-password-12345",
        displayName: "Web User",
      },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().session.accessToken).toBeUndefined();
    const setCookies = normalizeSetCookie(registered.headers["set-cookie"]);
    expect(
      setCookies.find((value) => value.startsWith("rafay_access=")),
    ).toContain("HttpOnly");
    const accessCookie = cookieFrom(
      registered.headers["set-cookie"],
      "rafay_access",
    );
    const sessionCsrfCookie = cookieFrom(
      registered.headers["set-cookie"],
      "rafay_csrf",
    );
    const sessionCsrfToken = sessionCsrfCookie.slice(
      sessionCsrfCookie.indexOf("=") + 1,
    );
    const sessionCookies = `${accessCookie}; ${sessionCsrfCookie}`;

    const rejected = await app.inject({
      method: "POST",
      url: "/v1/pairs/current",
      headers: {
        "x-rafay-client": "web",
        origin: "http://localhost:4173",
        cookie: accessCookie,
      },
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().code).toBe("CSRF_VALIDATION_FAILED");

    const webPair = await app.inject({
      method: "POST",
      url: "/v1/pairs/current",
      headers: {
        "x-rafay-client": "web",
        "x-csrf-token": sessionCsrfToken,
        origin: "http://localhost:4173",
        cookie: sessionCookies,
      },
    });
    expect(webPair.statusCode).toBe(201);
    const nativePartner = await registerNative(
      "web-partner@example.test",
      "Web Partner",
    );
    await app.inject({
      method: "POST",
      url: "/v1/pairs/join",
      headers: nativeHeaders(nativePartner.accessToken),
      payload: { code: webPair.json().pair.joinCode },
    });
    const webTicket = await app.inject({
      method: "POST",
      url: "/v1/realtime/tickets",
      headers: {
        "x-rafay-client": "web",
        "x-csrf-token": sessionCsrfToken,
        origin: "http://localhost:4173",
        cookie: sessionCookies,
      },
      payload: {},
    });
    expect(webTicket.statusCode).toBe(200);
    expect(new URL(webTicket.json().webSocketUrl).origin).toBe(
      "ws://localhost:4173",
    );
  });

  it("binds native notification installations to the session family and caps abuse", async () => {
    const session = await registerNative(
      "notifications@example.test",
      "Notifications User",
    );
    const installations = Array.from({ length: 6 }, () => crypto.randomUUID());
    const registerDevice = (index: number, tokenSuffix = "initial") =>
      app.inject({
        method: "POST",
        url: "/v1/notification-devices",
        headers: nativeHeaders(session.accessToken),
        payload: {
          platform: "ios",
          installationId: installations[index],
          token: `apns-device-${String(index)}-${tokenSuffix}-0000000000000000`,
        },
      });

    for (let index = 0; index < 5; index += 1) {
      const registered = await registerDevice(index);
      expect(registered.statusCode, registered.body).toBe(201);
      expect(registered.json().device.expiresAt).toMatch(/Z$/u);
    }
    const capped = await registerDevice(5);
    expect(capped.statusCode).toBe(429);
    expect(capped.json().code).toBe("DEVICE_LIMIT_REACHED");

    const rotated = await registerDevice(0, "rotated");
    expect(rotated.statusCode).toBe(201);
    const activeBeforeLogout = await pool.query<{
      count: string;
      bound: boolean;
    }>(
      `
        SELECT count(*)::text AS count,
          bool_and(EXISTS (
            SELECT 1 FROM auth_sessions session
            WHERE session.family_id = device.session_family_id
              AND session.user_id = device.user_id
          )) AS bound
        FROM notification_devices device
        JOIN users owner ON owner.id = device.user_id
        WHERE owner.email = 'notifications@example.test'
          AND device.disabled_at IS NULL
      `,
    );
    expect(activeBeforeLogout.rows[0]).toMatchObject({
      count: "5",
      bound: true,
    });

    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { "x-rafay-client": "ios" },
      payload: { refreshToken: session.refreshToken },
    });
    expect(logout.statusCode).toBe(204);
    const activeAfterLogout = await pool.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM notification_devices device
        JOIN users owner ON owner.id = device.user_id
        WHERE owner.email = 'notifications@example.test'
          AND device.disabled_at IS NULL
      `,
    );
    expect(activeAfterLogout.rows[0]?.count).toBe("0");
  }, 15_000);

  it("serializes partner actions behind consent revocation and rechecks after the lock", async () => {
    const sender = await registerNative(
      "race-sender@example.test",
      "Race Sender",
    );
    const recipient = await registerNative(
      "race-recipient@example.test",
      "Race Recipient",
    );
    const created = await app.inject({
      method: "POST",
      url: "/v1/pairs/current",
      headers: nativeHeaders(sender.accessToken),
    });
    const pair = created.json().pair as { id: string; joinCode: string };
    await app.inject({
      method: "POST",
      url: "/v1/pairs/join",
      headers: nativeHeaders(recipient.accessToken),
      payload: { code: pair.joinCode },
    });
    await app.inject({
      method: "PUT",
      url: "/v1/consents",
      headers: nativeHeaders(recipient.accessToken),
      payload: { grants: [{ capability: "care_requests", granted: true }] },
    });

    const blocker = await pool.connect();
    const clientRequestId = crypto.randomUUID();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM pairs WHERE id = $1 FOR UPDATE", [
        pair.id,
      ]);
      await blocker.query(
        `
          UPDATE consent_grants
          SET granted = false, updated_at = now()
          WHERE pair_id = $1
            AND grantor_user_id = (
              SELECT id FROM users WHERE email = 'race-recipient@example.test'
            )
            AND capability = 'care_requests'
        `,
        [pair.id],
      );
      let settled = false;
      const care = app
        .inject({
          method: "POST",
          url: "/v1/care-requests",
          headers: nativeHeaders(sender.accessToken),
          payload: { clientRequestId, kind: "check_in" },
        })
        .finally(() => {
          settled = true;
        });
      await delay(100);
      expect(settled).toBe(false);
      await blocker.query("COMMIT");
      const response = await care;
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("CONSENT_DENIED");
      const inserted = await pool.query<{ count: string }>(
        "SELECT count(*)::text FROM care_requests WHERE client_request_id = $1",
        [clientRequestId],
      );
      expect(inserted.rows[0]?.count).toBe("0");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("keeps tickets out of URLs, fences replay by worker authorization and consent, and closes rotated sessions", async () => {
    const sender = await registerNative(
      "realtime-sender@example.test",
      "Realtime Sender",
    );
    const recipient = await registerNative(
      "realtime-recipient@example.test",
      "Realtime Recipient",
    );
    const created = await app.inject({
      method: "POST",
      url: "/v1/pairs/current",
      headers: nativeHeaders(sender.accessToken),
    });
    const pair = created.json().pair as { id: string; joinCode: string };
    await app.inject({
      method: "POST",
      url: "/v1/pairs/join",
      headers: nativeHeaders(recipient.accessToken),
      payload: { code: pair.joinCode },
    });
    await app.inject({
      method: "PUT",
      url: "/v1/consents",
      headers: nativeHeaders(recipient.accessToken),
      payload: { grants: [{ capability: "care_requests", granted: true }] },
    });
    const sent = await app.inject({
      method: "POST",
      url: "/v1/care-requests",
      headers: nativeHeaders(sender.accessToken),
      payload: {
        clientRequestId: crypto.randomUUID(),
        kind: "check_in",
      },
    });
    expect(sent.statusCode).toBe(201);

    const rawTicket = await issueRealtimeTicket(sender.accessToken);
    expect(new URL(rawTicket.webSocketUrl).search).toBe("");
    expect(new URL(rawTicket.webSocketUrl).origin).toBe("ws://localhost:3000");
    expect(rawTicket.webSocketUrl).not.toContain(rawTicket.ticket);
    const rawMessages: string[] = [];
    const rawSocket = await openRealtimeSocket(rawTicket, (message) => {
      rawMessages.push(message);
    });
    await delay(150);
    expect(rawMessages).toEqual([]);
    const secondSocket = await openRealtimeSocket(
      await issueRealtimeTicket(sender.accessToken),
      () => undefined,
    );
    const cappedTicket = await issueRealtimeTicket(sender.accessToken);
    const cappedSocket = new WebSocket(realtimeSocketUrl, [
      "rafaypair.v1",
      `rafaypair.ticket.${cappedTicket.ticket}`,
    ]);
    await expect(
      waitForSocketClose(cappedSocket, 2_000),
    ).resolves.toMatchObject({
      code: 1013,
    });
    rawSocket.close();
    secondSocket.close();
    await delay(50);
    const inboundSocket = await openRealtimeSocket(
      await issueRealtimeTicket(sender.accessToken),
      () => undefined,
    );
    const inboundClosed = waitForSocketClose(inboundSocket, 2_000);
    inboundSocket.send("unsupported client frame");
    await expect(inboundClosed).resolves.toMatchObject({ code: 1008 });
    await delay(25);

    await pool.query(
      `
        UPDATE realtime_events
        SET delivery_authorized_at = now(),
            delivery_authorized_revision = authorization_revision
        WHERE pair_id = $1
      `,
      [pair.id],
    );
    const replayTicket = await issueRealtimeTicket(sender.accessToken);
    const replayed = new Promise<RealtimeEventEnvelope>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("authorized replay was not delivered")),
        2_000,
      );
      void openRealtimeSocket(replayTicket, (message) => {
        clearTimeout(timeout);
        resolve(JSON.parse(message) as RealtimeEventEnvelope);
      });
    });
    const authorizedEvent = await replayed;
    expect(authorizedEvent.type).toBe("care.request.created");
    expect(authorizedEvent.authorizationRevision).toMatch(/^\d+$/);
    await pool.query(
      "UPDATE outbox_events SET processed_at = now() WHERE pair_id = $1",
      [pair.id],
    );
    for (const client of app.websocketServer.clients) client.terminate();

    await pool.query(
      `
        WITH template AS (
          SELECT pair_id, event_type, payload, authorization_revision
          FROM realtime_events
          WHERE event_uuid = $1
        ), inserted AS (
          INSERT INTO realtime_events (
            event_uuid, pair_id, event_type, payload, occurred_at,
            authorization_revision, delivery_authorized_at,
            delivery_authorized_revision
          )
          SELECT gen_random_uuid(), template.pair_id, template.event_type,
                 template.payload, now() + (series.n * interval '1 microsecond'),
                 template.authorization_revision, now(),
                 template.authorization_revision
          FROM template CROSS JOIN generate_series(1, 550) AS series(n)
          RETURNING id, event_uuid, pair_id, event_type, payload, occurred_at,
                    authorization_revision
        )
        INSERT INTO outbox_events (
          event_uuid, event_type, aggregate_type, aggregate_id, pair_id,
          actor_user_id, recipient_user_id, payload, occurred_at,
          processed_at, authorization_revision
        )
        SELECT event_uuid, event_type, 'care_request', gen_random_uuid(), pair_id,
               (payload->>'actorUserId')::uuid,
               (payload->>'recipientUserId')::uuid,
               payload || jsonb_build_object('eventId', id::text), occurred_at,
               now(), authorization_revision
        FROM inserted
      `,
      [authorizedEvent.id],
    );
    const bulkTicket = await issueRealtimeTicket(
      sender.accessToken,
      authorizedEvent.eventId,
    );
    const bulkMessages: RealtimeEventEnvelope[] = [];
    let resolveBulk!: () => void;
    const bulkDelivered = new Promise<void>((resolve) => {
      resolveBulk = resolve;
    });
    const bulkSocket = await openRealtimeSocket(bulkTicket, (message) => {
      bulkMessages.push(JSON.parse(message) as RealtimeEventEnvelope);
      if (bulkMessages.length === 550) resolveBulk();
    });
    await Promise.race([
      bulkDelivered,
      delay(10_000).then(() => {
        throw new Error(
          `paged replay delivered only ${bulkMessages.length}/550 events`,
        );
      }),
    ]);
    expect(bulkMessages).toHaveLength(550);
    expect(bulkMessages.map((event) => BigInt(event.eventId))).toEqual(
      [...bulkMessages]
        .map((event) => BigInt(event.eventId))
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    );
    bulkSocket.close();

    const revoked = await app.inject({
      method: "PUT",
      url: "/v1/consents",
      headers: nativeHeaders(recipient.accessToken),
      payload: { grants: [{ capability: "care_requests", granted: false }] },
    });
    expect(revoked.statusCode).toBe(200);

    const deniedReplayTicket = await issueRealtimeTicket(sender.accessToken);
    const deniedMessages: string[] = [];
    const established = await openRealtimeSocket(
      deniedReplayTicket,
      (message) => deniedMessages.push(message),
    );
    await delay(150);
    expect(deniedMessages).toEqual([]);
    await realtimeBroker.publish(authorizedEvent);
    await delay(150);
    expect(deniedMessages).toEqual([]);

    const closed = waitForSocketClose(established, 7_000);
    const rotated = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { "x-rafay-client": "ios" },
      payload: { refreshToken: sender.refreshToken },
    });
    expect(rotated.statusCode).toBe(200);
    await expect(closed).resolves.toMatchObject({ code: 1008 });
  }, 15_000);
});

async function registerNative(
  email: string,
  displayName: string,
  platform: "ios" | "android" = "ios",
): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    remoteAddress: `192.0.2.${registrationAddress++}`,
    headers: { "x-rafay-client": platform },
    payload: { email, displayName, password: `${displayName}-password-12345` },
  });
  expect(response.statusCode).toBe(201);
  const payload = response.json() as {
    user: { id: string };
    session: { accessToken: string; refreshToken: string };
  };
  return { ...payload.session, userId: payload.user.id };
}

function nativeHeaders(
  accessToken: string,
  platform: "ios" | "android" = "ios",
): Record<string, string> {
  return { authorization: `Bearer ${accessToken}`, "x-rafay-client": platform };
}

async function issueIosAssertionChallenge(
  accessToken: string,
  keyId: string,
): Promise<{ id: string; clientData: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/integrity/ios/challenges",
    headers: nativeHeaders(accessToken, "ios"),
    payload: { action: "session_start", supported: true, keyId },
  });
  expect(response.statusCode).toBe(201);
  expect(response.json().challenge.mode).toBe("assertion");
  return response.json().challenge as { id: string; clientData: string };
}

function createTestAppAttestAssertion(
  encodedClientData: string,
  counter: number,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
): string {
  const counterBytes = Buffer.alloc(4);
  counterBytes.writeUInt32BE(counter);
  const authenticatorData = Buffer.concat([
    createHash("sha256")
      .update("ABCDEFGHIJ.com.rafaypair.app", "utf8")
      .digest(),
    Buffer.from([0]),
    counterBytes,
  ]);
  const clientDataHash = createHash("sha256")
    .update(Buffer.from(encodedClientData, "base64url"))
    .digest();
  const signature = sign(
    "sha256",
    Buffer.concat([authenticatorData, clientDataHash]),
    privateKey,
  );
  return encodeTestCborMap([
    ["signature", signature],
    ["authenticatorData", authenticatorData],
  ]).toString("base64");
}

function encodeTestCborMap(
  entries: readonly (readonly [string, Buffer])[],
): Buffer {
  return Buffer.concat([
    encodeTestCborLength(5, entries.length),
    ...entries.flatMap(([key, value]) => {
      const keyBytes = Buffer.from(key, "utf8");
      return [
        encodeTestCborLength(3, keyBytes.length),
        keyBytes,
        encodeTestCborLength(2, value.length),
        value,
      ];
    }),
  ]);
}

function encodeTestCborLength(majorType: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(majorType << 5) | length]);
  if (length <= 0xff) return Buffer.from([(majorType << 5) | 24, length]);
  const encoded = Buffer.alloc(3);
  encoded[0] = (majorType << 5) | 25;
  encoded.writeUInt16BE(length, 1);
  return encoded;
}

function normalizeSetCookie(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function cookieFrom(
  value: string | string[] | undefined,
  name: string,
): string {
  const cookie = normalizeSetCookie(value).find((item) =>
    item.startsWith(`${name}=`),
  );
  if (!cookie) throw new Error(`Missing ${name} cookie`);
  return cookie.split(";", 1)[0] ?? "";
}

interface RealtimeTicketFixture {
  ticket: string;
  webSocketUrl: string;
}

async function issueRealtimeTicket(
  accessToken: string,
  lastEventId?: string,
): Promise<RealtimeTicketFixture> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/realtime/tickets",
    headers: nativeHeaders(accessToken),
    payload: lastEventId ? { lastEventId } : {},
  });
  expect(response.statusCode).toBe(200);
  return response.json() as RealtimeTicketFixture;
}

async function openRealtimeSocket(
  ticket: RealtimeTicketFixture,
  onMessage: (message: string) => void,
): Promise<WebSocket> {
  const socket = new WebSocket(realtimeSocketUrl, [
    "rafaypair.v1",
    `rafaypair.ticket.${ticket.ticket}`,
  ]);
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") onMessage(event.data);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("realtime socket failed to open")),
      { once: true },
    );
  });
  expect(socket.protocol).toBe("rafaypair.v1");
  return socket;
}

function waitForSocketClose(
  socket: WebSocket,
  timeoutMs: number,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("realtime socket did not close in time")),
      timeoutMs,
    );
    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timeout);
        resolve({ code: event.code, reason: event.reason });
      },
      { once: true },
    );
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
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

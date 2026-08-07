import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type {
  AppAttestMode,
  IosIntegrityAction,
} from "@rafay-pair/api-contracts";

import {
  issueDeviceIntegrityChallenge,
  type DeviceIntegrityChallenge,
} from "./device-integrity.js";
import {
  AppAttestVerificationError,
  verifyAppAssertion,
  verifyAppAttestation,
  type AppAttestEnvironment,
  type AppAttestVerifierConfiguration,
} from "./integrity/app-attest-verifier.js";
import type { AuthContext } from "./types.js";

const clientDataVersion = "rafaypair.app-attest.v1";
const assessmentMethod = "POST";
const assessmentPath = "/v1/integrity/ios/assessments";

export interface IssuedAppAttestChallenge extends DeviceIntegrityChallenge {
  mode: AppAttestMode;
  clientData: string;
}

export type AppAttestSubmission =
  | {
      challengeId: string;
      action: IosIntegrityAction;
      mode: "attestation";
      keyId: string;
      attestationObject: string;
    }
  | {
      challengeId: string;
      action: IosIntegrityAction;
      mode: "assertion";
      keyId: string;
      assertionObject: string;
    }
  | {
      challengeId: string;
      action: IosIntegrityAction;
      mode: "unsupported";
    };

export interface AppAttestEvaluation {
  signal: "low_risk" | "elevated_risk" | "invalid_binding";
  bindingValid: boolean;
  metadata: Record<string, unknown>;
}

interface AppAttestChallengeBinding {
  challengeId: string;
  action: string;
  mode: AppAttestMode;
  serverChallenge: Buffer;
  keyIdHash: Buffer | null;
  environment: AppAttestEnvironment;
}

interface StoredAppAttestKey {
  id: string;
  userId: string;
  environment: AppAttestEnvironment;
  publicKeySpki: Buffer;
  signCount: number;
  revokedAt: Date | null;
}

export async function issueAppAttestChallenge(
  pool: Pool,
  auth: AuthContext,
  input: {
    action: IosIntegrityAction;
    supported: boolean;
    keyId?: string | undefined;
  },
  environment: AppAttestEnvironment,
): Promise<IssuedAppAttestChallenge> {
  const keyIdHash = input.supported
    ? hashAppAttestKeyId(requireKeyId(input.keyId))
    : undefined;
  const serverChallenge = randomBytes(32);
  let issuedBinding: AppAttestChallengeBinding | undefined;
  const challenge = await issueDeviceIntegrityChallenge(
    pool,
    auth,
    "ios",
    input.action,
    async (client, issued) => {
      let mode: AppAttestMode = "unsupported";
      if (keyIdHash) {
        await lockAppAttestKey(client, keyIdHash);
        const stored = await findAppAttestKey(client, keyIdHash, false);
        mode =
          stored &&
          stored.userId === auth.userId &&
          stored.environment === environment &&
          stored.revokedAt === null
            ? "assertion"
            : "attestation";
      }
      await client.query(
        `
          INSERT INTO app_attest_challenge_bindings(
            challenge_id, mode, server_challenge, key_id_hash, environment
          ) VALUES ($1, $2, $3, $4, $5)
        `,
        [issued.id, mode, serverChallenge, keyIdHash ?? null, environment],
      );
      issuedBinding = {
        challengeId: issued.id,
        action: issued.action,
        mode,
        serverChallenge,
        keyIdHash: keyIdHash ?? null,
        environment,
      };
    },
  );
  if (!issuedBinding) {
    throw new Error("App Attest challenge binding was not created");
  }
  return {
    ...challenge,
    mode: issuedBinding.mode,
    clientData: createAppAttestClientData(issuedBinding).toString("base64url"),
  };
}

export async function evaluateAppAttestSubmission(
  client: PoolClient,
  auth: AuthContext,
  submission: AppAttestSubmission,
  configuration: AppAttestVerifierConfiguration,
): Promise<AppAttestEvaluation> {
  const binding = await loadChallengeBinding(client, submission.challengeId);
  if (
    binding.action !== submission.action ||
    binding.mode !== submission.mode ||
    binding.environment !== configuration.environment
  ) {
    return invalidEvaluation("challenge_binding_mismatch", submission.mode);
  }
  if (submission.mode === "unsupported") {
    return {
      signal: "elevated_risk",
      bindingValid: false,
      metadata: {
        providerResult: "unsupported",
        proofType: "unsupported",
        environment: binding.environment,
      },
    };
  }

  let submittedKeyHash: Buffer;
  try {
    submittedKeyHash = hashAppAttestKeyId(submission.keyId);
  } catch {
    return invalidEvaluation("verification_failed", submission.mode);
  }
  if (
    binding.keyIdHash === null ||
    !safeEqual(binding.keyIdHash, submittedKeyHash)
  ) {
    return invalidEvaluation("key_binding_mismatch", submission.mode);
  }

  await lockAppAttestKey(client, submittedKeyHash);
  const clientData = createAppAttestClientData(binding);
  if (submission.mode === "attestation") {
    return evaluateAttestation(
      client,
      auth,
      submission,
      submittedKeyHash,
      clientData,
      configuration,
    );
  }
  return evaluateAssertion(
    client,
    auth,
    submission,
    submittedKeyHash,
    clientData,
    configuration,
  );
}

export function createAppAttestClientData(input: {
  challengeId: string;
  action: string;
  mode: AppAttestMode;
  serverChallenge: Buffer;
}): Buffer {
  if (
    !/^[0-9a-f-]{36}$/iu.test(input.challengeId) ||
    !/^[a-z][a-z0-9_]{0,63}$/u.test(input.action) ||
    input.serverChallenge.length !== 32
  ) {
    throw new Error("Invalid App Attest client-data binding");
  }
  return Buffer.from(
    [
      clientDataVersion,
      assessmentMethod,
      assessmentPath,
      input.challengeId.toLowerCase(),
      input.action,
      input.mode,
      input.serverChallenge.toString("base64url"),
    ].join("\n"),
    "utf8",
  );
}

export function hashAppAttestKeyId(keyId: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(keyId)) {
    throw new AppAttestVerificationError("invalid_key_binding");
  }
  const decoded = Buffer.from(keyId, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== keyId) {
    throw new AppAttestVerificationError("invalid_key_binding");
  }
  return createHash("sha256").update(decoded).digest();
}

async function evaluateAttestation(
  client: PoolClient,
  auth: AuthContext,
  submission: Extract<AppAttestSubmission, { mode: "attestation" }>,
  keyIdHash: Buffer,
  clientData: Buffer,
  configuration: AppAttestVerifierConfiguration,
): Promise<AppAttestEvaluation> {
  const existing = await findAppAttestKey(client, keyIdHash, true);
  if (existing) {
    return invalidEvaluation("key_already_registered", "attestation");
  }
  try {
    const verified = verifyAppAttestation(
      {
        attestationObject: decodeProof(
          submission.attestationObject,
          64 * 1_024,
        ),
        keyId: submission.keyId,
        clientDataHash: createHash("sha256").update(clientData).digest(),
      },
      configuration,
    );
    await client.query(
      `
        INSERT INTO app_attest_keys(
          user_id, key_id_hash, environment, public_key_spki, receipt,
          sign_count, validation_category, bundle_version
        ) VALUES ($1, $2, $3, $4, $5, 0, $6, $7)
      `,
      [
        auth.userId,
        keyIdHash,
        verified.environment,
        verified.publicKeySpki,
        verified.receipt,
        verified.validationCategory ?? null,
        verified.bundleVersion ?? null,
      ],
    );
    return {
      signal: verified.signal,
      bindingValid: true,
      metadata: {
        providerResult: "verified",
        proofType: "attestation",
        ...verified.metadata,
      },
    };
  } catch (error) {
    if (error instanceof AppAttestVerificationError) {
      return invalidEvaluation("verification_failed", "attestation");
    }
    throw error;
  }
}

async function evaluateAssertion(
  client: PoolClient,
  auth: AuthContext,
  submission: Extract<AppAttestSubmission, { mode: "assertion" }>,
  keyIdHash: Buffer,
  clientData: Buffer,
  configuration: AppAttestVerifierConfiguration,
): Promise<AppAttestEvaluation> {
  const stored = await findAppAttestKey(client, keyIdHash, true);
  if (
    !stored ||
    stored.userId !== auth.userId ||
    stored.environment !== configuration.environment ||
    stored.revokedAt !== null
  ) {
    return invalidEvaluation("unknown_key", "assertion");
  }
  try {
    const verified = verifyAppAssertion(
      {
        assertionObject: decodeProof(submission.assertionObject, 16 * 1_024),
        clientData,
        publicKeySpki: stored.publicKeySpki,
        previousCounter: stored.signCount,
      },
      configuration,
    );
    const updated = await client.query(
      `
        UPDATE app_attest_keys
        SET sign_count = $2,
            validation_category = $3,
            bundle_version = $4,
            last_asserted_at = now()
        WHERE id = $1
          AND sign_count = $5
          AND revoked_at IS NULL
        RETURNING id
      `,
      [
        stored.id,
        verified.counter,
        verified.validationCategory ?? null,
        verified.bundleVersion ?? null,
        stored.signCount,
      ],
    );
    if (updated.rowCount !== 1) {
      return invalidEvaluation("counter_race", "assertion");
    }
    return {
      signal: verified.signal,
      bindingValid: true,
      metadata: {
        providerResult: "verified",
        proofType: "assertion",
        counterAdvanced: true,
        ...verified.metadata,
      },
    };
  } catch (error) {
    if (error instanceof AppAttestVerificationError) {
      return invalidEvaluation("verification_failed", "assertion");
    }
    throw error;
  }
}

async function loadChallengeBinding(
  client: PoolClient,
  challengeId: string,
): Promise<AppAttestChallengeBinding> {
  const result = await client.query<{
    challenge_id: string;
    action: string;
    mode: AppAttestMode;
    server_challenge: Buffer;
    key_id_hash: Buffer | null;
    environment: AppAttestEnvironment;
  }>(
    `
      SELECT b.challenge_id, c.action, b.mode, b.server_challenge,
             b.key_id_hash, b.environment
      FROM app_attest_challenge_bindings b
      JOIN device_integrity_challenges c ON c.id = b.challenge_id
      WHERE b.challenge_id = $1
      FOR UPDATE OF b
    `,
    [challengeId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("App Attest challenge binding is missing");
  return {
    challengeId: row.challenge_id,
    action: row.action,
    mode: row.mode,
    serverChallenge: row.server_challenge,
    keyIdHash: row.key_id_hash,
    environment: row.environment,
  };
}

async function findAppAttestKey(
  client: PoolClient,
  keyIdHash: Buffer,
  lock: boolean,
): Promise<StoredAppAttestKey | undefined> {
  const result = await client.query<{
    id: string;
    user_id: string;
    environment: AppAttestEnvironment;
    public_key_spki: Buffer;
    sign_count: string;
    revoked_at: Date | null;
  }>(
    `
      SELECT id, user_id, environment, public_key_spki,
             sign_count::text, revoked_at
      FROM app_attest_keys
      WHERE key_id_hash = $1
      ${lock ? "FOR UPDATE" : ""}
    `,
    [keyIdHash],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const signCount = Number(row.sign_count);
  if (!Number.isSafeInteger(signCount) || signCount < 0) {
    throw new Error("Stored App Attest counter is invalid");
  }
  return {
    id: row.id,
    userId: row.user_id,
    environment: row.environment,
    publicKeySpki: row.public_key_spki,
    signCount,
    revokedAt: row.revoked_at,
  };
}

async function lockAppAttestKey(
  client: PoolClient,
  keyIdHash: Buffer,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended(encode($1::bytea, 'hex'), 73))",
    [keyIdHash],
  );
}

function decodeProof(value: string, maximumBytes: number): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length === 0 ||
    decoded.length > maximumBytes ||
    decoded.toString("base64") !== value
  ) {
    throw new AppAttestVerificationError("malformed_object");
  }
  return decoded;
}

function invalidEvaluation(
  providerResult: string,
  proofType: AppAttestMode,
): AppAttestEvaluation {
  return {
    signal: "invalid_binding",
    bindingValid: false,
    metadata: { providerResult, proofType },
  };
}

function requireKeyId(keyId: string | undefined): string {
  if (!keyId) throw new Error("Supported App Attest request requires a key ID");
  return keyId;
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

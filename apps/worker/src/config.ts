import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute } from "node:path";

import { z } from "zod";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().url(),
  DATABASE_CA_CERT_PATH: z.preprocess(
    // Container images bake a production default; local compose clears it
    // with an empty value because TLS-disabled URLs reject a CA bundle.
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().trim().min(1).max(1_024).optional(),
  ),
  REDIS_URL: z.string().url(),
  SESSION_PEPPER: z.string().min(32),
  DEVICE_TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  WORKER_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(10_000)
    .default(500),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(3_001),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  APNS_TEAM_ID: z.string().optional(),
  APNS_KEY_ID: z.string().optional(),
  APNS_BUNDLE_ID: z.string().optional(),
  APNS_PRIVATE_KEY: z.string().optional(),
  APNS_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
  FCM_PROJECT_ID: z.string().optional(),
  FCM_CLIENT_EMAIL: z.string().email().optional(),
  FCM_PRIVATE_KEY: z.string().optional(),
});

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;

export function loadWorkerConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.parse(environment);
  validateDatabaseTransport(parsed.DATABASE_URL, parsed.NODE_ENV);
  if (parsed.NODE_ENV === "production" && !parsed.DATABASE_CA_CERT_PATH) {
    throw new Error(
      "DATABASE_CA_CERT_PATH is required for verified production database TLS",
    );
  }
  if (
    parsed.DATABASE_CA_CERT_PATH &&
    !isAbsolute(parsed.DATABASE_CA_CERT_PATH)
  ) {
    throw new Error("DATABASE_CA_CERT_PATH must be an absolute path");
  }
  if (parsed.NODE_ENV === "production" && !parsed.DEVICE_TOKEN_ENCRYPTION_KEY) {
    throw new Error("DEVICE_TOKEN_ENCRYPTION_KEY is required in production");
  }
  if (parsed.NODE_ENV === "production") {
    if (!parsed.REDIS_URL.startsWith("rediss://")) {
      throw new Error("REDIS_URL must use TLS (rediss://) in production");
    }
    if (
      new URL(parsed.DATABASE_URL).searchParams.get("sslmode") === "disable"
    ) {
      throw new Error("DATABASE_URL cannot disable TLS in production");
    }
  }
  const apnsValues = [
    parsed.APNS_TEAM_ID,
    parsed.APNS_KEY_ID,
    parsed.APNS_BUNDLE_ID,
    parsed.APNS_PRIVATE_KEY,
  ];
  if (apnsValues.some(Boolean) && !apnsValues.every(Boolean)) {
    throw new Error(
      "APNs configuration must provide team id, key id, bundle id, and private key together",
    );
  }
  const fcmValues = [
    parsed.FCM_PROJECT_ID,
    parsed.FCM_CLIENT_EMAIL,
    parsed.FCM_PRIVATE_KEY,
  ];
  if (fcmValues.some(Boolean) && !fcmValues.every(Boolean)) {
    throw new Error(
      "FCM configuration must provide project id, client email, and private key together",
    );
  }
  if (parsed.NODE_ENV === "production" && !apnsValues.every(Boolean)) {
    throw new Error("Complete APNs configuration is required in production");
  }
  if (parsed.NODE_ENV === "production" && !fcmValues.every(Boolean)) {
    throw new Error("Complete FCM configuration is required in production");
  }
  return {
    nodeEnv: parsed.NODE_ENV,
    databaseUrl: parsed.DATABASE_URL,
    ...(parsed.DATABASE_CA_CERT_PATH
      ? { databaseCaCertificatePath: parsed.DATABASE_CA_CERT_PATH }
      : {}),
    redisUrl: parsed.REDIS_URL,
    sessionPepper: parsed.SESSION_PEPPER,
    ...(parsed.DEVICE_TOKEN_ENCRYPTION_KEY
      ? { deviceTokenEncryptionKey: parsed.DEVICE_TOKEN_ENCRYPTION_KEY }
      : {}),
    pollIntervalMs: parsed.WORKER_POLL_INTERVAL_MS,
    healthPort: parsed.WORKER_HEALTH_PORT,
    logLevel: parsed.LOG_LEVEL,
    workerId: `${hostname()}:${process.pid}`,
    apns:
      parsed.APNS_TEAM_ID &&
      parsed.APNS_KEY_ID &&
      parsed.APNS_BUNDLE_ID &&
      parsed.APNS_PRIVATE_KEY
        ? {
            teamId: parsed.APNS_TEAM_ID,
            keyId: parsed.APNS_KEY_ID,
            bundleId: parsed.APNS_BUNDLE_ID,
            privateKey: parsed.APNS_PRIVATE_KEY,
            environment: parsed.APNS_ENVIRONMENT,
          }
        : undefined,
    fcm:
      parsed.FCM_PROJECT_ID && parsed.FCM_CLIENT_EMAIL && parsed.FCM_PRIVATE_KEY
        ? {
            projectId: parsed.FCM_PROJECT_ID,
            clientEmail: parsed.FCM_CLIENT_EMAIL,
            privateKey: parsed.FCM_PRIVATE_KEY,
          }
        : undefined,
  };
}

export async function loadWorkerDatabaseCaCertificate(
  certificatePath: string | undefined,
): Promise<string | undefined> {
  if (!certificatePath) return undefined;
  const certificateBundle = await readFile(certificatePath, "utf8");
  const certificates = certificateBundle.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu,
  );
  if (
    Buffer.byteLength(certificateBundle, "utf8") < 512 ||
    Buffer.byteLength(certificateBundle, "utf8") > 1_000_000 ||
    !certificates ||
    certificates.length === 0 ||
    certificates.length > 256 ||
    certificates.join("\n").replaceAll(/\s+/gu, "") !==
      certificateBundle.replaceAll(/\s+/gu, "")
  ) {
    throw new Error(
      "DATABASE_CA_CERT_PATH does not contain a valid PEM bundle",
    );
  }
  try {
    for (const encoded of certificates) {
      const certificate = new X509Certificate(encoded);
      if (!certificate.ca || !certificate.verify(certificate.publicKey)) {
        throw new Error("not a self-signed root CA");
      }
    }
  } catch {
    throw new Error(
      "DATABASE_CA_CERT_PATH must contain only valid self-signed root CA certificates",
    );
  }
  return certificateBundle;
}

function validateDatabaseTransport(
  databaseUrl: string,
  nodeEnvironment: "development" | "test" | "production",
): void {
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres protocol");
  }
  for (const unsupportedOption of [
    "ssl",
    "sslcert",
    "sslkey",
    "sslrootcert",
    "uselibpqcompat",
  ]) {
    if (parsed.searchParams.has(unsupportedOption)) {
      throw new Error(
        `DATABASE_URL cannot override TLS with ${unsupportedOption}`,
      );
    }
  }
  const sslMode = parsed.searchParams.get("sslmode");
  if (sslMode !== null && sslMode !== "disable" && sslMode !== "verify-full") {
    throw new Error("DATABASE_URL sslmode must be disable or verify-full");
  }
  if (nodeEnvironment === "production" && sslMode === "disable") {
    throw new Error("DATABASE_URL cannot disable TLS in production");
  }
}

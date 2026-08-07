import { isIP } from "node:net";
import { isAbsolute } from "node:path";

import { z } from "zod";

import type { AppAttestVerifierConfiguration } from "./integrity/app-attest-verifier.js";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  PUBLIC_API_URL: z.string().url().optional(),
  PUBLIC_WEB_ORIGIN: z.string().url().optional(),
  ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:5173,http://localhost:4173"),
  DATABASE_URL: z.string().url(),
  DATABASE_CA_CERT_PATH: z.preprocess(
    // Container images bake a production default; local compose clears it
    // with an empty value because TLS-disabled URLs reject a CA bundle.
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().trim().min(1).max(1_024).optional(),
  ),
  REDIS_URL: z.string().url(),
  REALTIME_MAX_CONNECTIONS_PER_USER: z.coerce
    .number()
    .int()
    .min(1)
    .max(16)
    .default(4),
  REALTIME_MAX_CONNECTIONS_PER_SESSION: z.coerce
    .number()
    .int()
    .min(1)
    .max(8)
    .default(2),
  REALTIME_CONNECTION_LEASE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(15)
    .max(120)
    .default(45),
  REALTIME_MAX_TICKETS_PER_USER_WINDOW: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(12),
  REALTIME_MAX_TICKETS_PER_SESSION_WINDOW: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(6),
  REALTIME_REPLAY_PAGE_SIZE: z.coerce
    .number()
    .int()
    .min(10)
    .max(500)
    .default(100),
  REALTIME_MAX_BUFFERED_EVENTS: z.coerce
    .number()
    .int()
    .min(100)
    .max(10_000)
    .default(1_000),
  REALTIME_MAX_SOCKET_BUFFER_BYTES: z.coerce
    .number()
    .int()
    .min(65_536)
    .max(16_777_216)
    .default(1_048_576),
  SESSION_PEPPER: z.string().min(32),
  EMAIL_TOKEN_PEPPER: z.string().min(32),
  DEVICE_TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  PLAY_INTEGRITY_PACKAGE_NAME: z
    .string()
    .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/)
    .optional(),
  PLAY_INTEGRITY_GOOGLE_CREDENTIALS_JSON: z
    .string()
    .min(2)
    .max(65_536)
    .optional(),
  PLAY_INTEGRITY_ALLOWED_CERTIFICATE_SHA256_DIGESTS: z.string().optional(),
  PLAY_INTEGRITY_MIN_VERSION_CODE: z.coerce
    .number()
    .int()
    .min(1)
    .max(2_100_000_000)
    .optional(),
  PLAY_INTEGRITY_PROVIDER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(15_000)
    .default(8_000),
  PLAY_INTEGRITY_MAX_TOKEN_AGE_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(300_000)
    .default(120_000),
  APP_ATTEST_TEAM_ID: z
    .string()
    .regex(/^[A-Z0-9]{10}$/u)
    .optional(),
  APP_ATTEST_BUNDLE_ID: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/u)
    .max(255)
    .optional(),
  APP_ATTEST_ENVIRONMENT: z.enum(["development", "production"]).optional(),
  APP_ATTEST_ALLOWED_VALIDATION_CATEGORIES: z.string().optional(),
  APP_ATTEST_ALLOWED_BUNDLE_VERSIONS: z.string().optional(),
  TRUST_PROXY: z.string().default("false"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export interface ApiConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  publicApiUrl?: string;
  publicWebOrigin?: string;
  allowedOrigins: readonly string[];
  databaseUrl: string;
  databaseCaCertificatePath?: string;
  redisUrl: string;
  realtimeMaxConnectionsPerUser: number;
  realtimeMaxConnectionsPerSession: number;
  realtimeConnectionLeaseTtlSeconds: number;
  realtimeMaxTicketsPerUserWindow: number;
  realtimeMaxTicketsPerSessionWindow: number;
  realtimeReplayPageSize: number;
  realtimeMaxBufferedEvents: number;
  realtimeMaxSocketBufferBytes: number;
  sessionPepper: string;
  joinCodePepper: string;
  deviceTokenEncryptionKey?: string;
  playIntegrity?: {
    packageName: string;
    googleCredentials: Record<string, unknown>;
    allowedCertificateSha256Digests: readonly string[];
    minimumVersionCode: number;
    providerTimeoutMs: number;
    maxTokenAgeMs: number;
  };
  appAttest?: AppAttestVerifierConfiguration;
  trustProxy: false | string[];
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ApiConfig {
  const parsed = environmentSchema.parse(environment);
  if (
    parsed.REALTIME_MAX_CONNECTIONS_PER_SESSION >
    parsed.REALTIME_MAX_CONNECTIONS_PER_USER
  ) {
    throw new Error(
      "REALTIME_MAX_CONNECTIONS_PER_SESSION cannot exceed REALTIME_MAX_CONNECTIONS_PER_USER",
    );
  }
  if (
    parsed.REALTIME_MAX_TICKETS_PER_SESSION_WINDOW >
    parsed.REALTIME_MAX_TICKETS_PER_USER_WINDOW
  ) {
    throw new Error(
      "REALTIME_MAX_TICKETS_PER_SESSION_WINDOW cannot exceed REALTIME_MAX_TICKETS_PER_USER_WINDOW",
    );
  }
  validateDatabaseTransport(parsed.DATABASE_URL, parsed.NODE_ENV);
  validateDatabaseCaCertificatePath(
    parsed.DATABASE_CA_CERT_PATH,
    parsed.NODE_ENV,
  );
  if (parsed.PUBLIC_API_URL)
    validatePublicOrigin("PUBLIC_API_URL", parsed.PUBLIC_API_URL);
  if (parsed.PUBLIC_WEB_ORIGIN)
    validatePublicOrigin("PUBLIC_WEB_ORIGIN", parsed.PUBLIC_WEB_ORIGIN);
  if (parsed.NODE_ENV === "production" && !parsed.DEVICE_TOKEN_ENCRYPTION_KEY) {
    throw new Error("DEVICE_TOKEN_ENCRYPTION_KEY is required in production");
  }
  const playIntegrity = parsePlayIntegrityConfig(parsed);
  if (parsed.NODE_ENV === "production" && !playIntegrity) {
    throw new Error(
      "Complete PLAY_INTEGRITY provider, package, signing-certificate, and version policy configuration is required in production",
    );
  }
  const appAttest = parseAppAttestConfig(parsed);
  if (parsed.NODE_ENV === "production" && !appAttest) {
    throw new Error(
      "Complete APP_ATTEST team, bundle, environment, validation-category, and bundle-version policy configuration is required in production",
    );
  }
  if (parsed.NODE_ENV === "production") {
    if (!parsed.PUBLIC_API_URL?.startsWith("https://")) {
      throw new Error("PUBLIC_API_URL must use HTTPS in production");
    }
    if (!parsed.PUBLIC_WEB_ORIGIN?.startsWith("https://")) {
      throw new Error("PUBLIC_WEB_ORIGIN must use HTTPS in production");
    }
    if (!parsed.REDIS_URL.startsWith("rediss://")) {
      throw new Error("REDIS_URL must use TLS (rediss://) in production");
    }
    if (
      new URL(parsed.DATABASE_URL).searchParams.get("sslmode") === "disable"
    ) {
      throw new Error("DATABASE_URL cannot disable TLS in production");
    }
    if (
      parsed.ALLOWED_ORIGINS.split(",").some(
        (origin) => !origin.trim().startsWith("https://"),
      )
    ) {
      throw new Error("Every production ALLOWED_ORIGINS value must use HTTPS");
    }
  }
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.API_HOST,
    port: parsed.API_PORT,
    ...(parsed.PUBLIC_API_URL ? { publicApiUrl: parsed.PUBLIC_API_URL } : {}),
    ...(parsed.PUBLIC_WEB_ORIGIN
      ? { publicWebOrigin: parsed.PUBLIC_WEB_ORIGIN }
      : {}),
    allowedOrigins: parsed.ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    databaseUrl: parsed.DATABASE_URL,
    ...(parsed.DATABASE_CA_CERT_PATH
      ? { databaseCaCertificatePath: parsed.DATABASE_CA_CERT_PATH }
      : {}),
    redisUrl: parsed.REDIS_URL,
    realtimeMaxConnectionsPerUser: parsed.REALTIME_MAX_CONNECTIONS_PER_USER,
    realtimeMaxConnectionsPerSession:
      parsed.REALTIME_MAX_CONNECTIONS_PER_SESSION,
    realtimeConnectionLeaseTtlSeconds:
      parsed.REALTIME_CONNECTION_LEASE_TTL_SECONDS,
    realtimeMaxTicketsPerUserWindow:
      parsed.REALTIME_MAX_TICKETS_PER_USER_WINDOW,
    realtimeMaxTicketsPerSessionWindow:
      parsed.REALTIME_MAX_TICKETS_PER_SESSION_WINDOW,
    realtimeReplayPageSize: parsed.REALTIME_REPLAY_PAGE_SIZE,
    realtimeMaxBufferedEvents: parsed.REALTIME_MAX_BUFFERED_EVENTS,
    realtimeMaxSocketBufferBytes: parsed.REALTIME_MAX_SOCKET_BUFFER_BYTES,
    sessionPepper: parsed.SESSION_PEPPER,
    joinCodePepper: parsed.EMAIL_TOKEN_PEPPER,
    ...(parsed.DEVICE_TOKEN_ENCRYPTION_KEY
      ? { deviceTokenEncryptionKey: parsed.DEVICE_TOKEN_ENCRYPTION_KEY }
      : {}),
    ...(playIntegrity ? { playIntegrity } : {}),
    ...(appAttest ? { appAttest } : {}),
    trustProxy: parseTrustedProxyCidrs(parsed.TRUST_PROXY),
    logLevel: parsed.LOG_LEVEL,
  };
}

function validateDatabaseCaCertificatePath(
  certificatePath: string | undefined,
  nodeEnvironment: "development" | "test" | "production",
): void {
  if (nodeEnvironment === "production" && !certificatePath) {
    throw new Error(
      "DATABASE_CA_CERT_PATH is required for verified production database TLS",
    );
  }
  if (certificatePath && !isAbsolute(certificatePath)) {
    throw new Error("DATABASE_CA_CERT_PATH must be an absolute path");
  }
}

function parseAppAttestConfig(parsed: {
  APP_ATTEST_TEAM_ID?: string | undefined;
  APP_ATTEST_BUNDLE_ID?: string | undefined;
  APP_ATTEST_ENVIRONMENT?: "development" | "production" | undefined;
  APP_ATTEST_ALLOWED_VALIDATION_CATEGORIES?: string | undefined;
  APP_ATTEST_ALLOWED_BUNDLE_VERSIONS?: string | undefined;
}): ApiConfig["appAttest"] {
  const teamId = parsed.APP_ATTEST_TEAM_ID;
  const bundleId = parsed.APP_ATTEST_BUNDLE_ID;
  const environment = parsed.APP_ATTEST_ENVIRONMENT;
  const rawCategories = parsed.APP_ATTEST_ALLOWED_VALIDATION_CATEGORIES;
  const rawVersions = parsed.APP_ATTEST_ALLOWED_BUNDLE_VERSIONS;
  if (!teamId && !bundleId && !environment && !rawCategories && !rawVersions) {
    return undefined;
  }
  if (!teamId || !bundleId || !environment || !rawCategories || !rawVersions) {
    throw new Error(
      "APP_ATTEST team, bundle, environment, validation categories, and bundle versions must be configured together",
    );
  }
  const categories = rawCategories
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const categoryNumbers = categories.map(Number);
  if (
    categoryNumbers.length === 0 ||
    categoryNumbers.length > 6 ||
    categoryNumbers.some(
      (value) => !Number.isInteger(value) || value < 1 || value > 6,
    ) ||
    new Set(categoryNumbers).size !== categoryNumbers.length
  ) {
    throw new Error(
      "APP_ATTEST_ALLOWED_VALIDATION_CATEGORIES must contain unique integers from 1 through 6",
    );
  }
  const versions = rawVersions
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    versions.length === 0 ||
    versions.length > 32 ||
    new Set(versions).size !== versions.length ||
    versions.some(
      (value) =>
        value.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value),
    )
  ) {
    throw new Error(
      "APP_ATTEST_ALLOWED_BUNDLE_VERSIONS must contain 1-32 unique release versions",
    );
  }
  return {
    appId: `${teamId}.${bundleId}`,
    environment,
    allowedValidationCategories: new Set(categoryNumbers),
    allowedBundleVersions: new Set(versions),
  };
}

function parsePlayIntegrityConfig(parsed: {
  PLAY_INTEGRITY_PACKAGE_NAME?: string | undefined;
  PLAY_INTEGRITY_GOOGLE_CREDENTIALS_JSON?: string | undefined;
  PLAY_INTEGRITY_ALLOWED_CERTIFICATE_SHA256_DIGESTS?: string | undefined;
  PLAY_INTEGRITY_MIN_VERSION_CODE?: number | undefined;
  PLAY_INTEGRITY_PROVIDER_TIMEOUT_MS: number;
  PLAY_INTEGRITY_MAX_TOKEN_AGE_MS: number;
}): ApiConfig["playIntegrity"] {
  const packageName = parsed.PLAY_INTEGRITY_PACKAGE_NAME;
  const rawCredentials = parsed.PLAY_INTEGRITY_GOOGLE_CREDENTIALS_JSON;
  const rawCertificateDigests =
    parsed.PLAY_INTEGRITY_ALLOWED_CERTIFICATE_SHA256_DIGESTS;
  const minimumVersionCode = parsed.PLAY_INTEGRITY_MIN_VERSION_CODE;
  if (
    !packageName &&
    !rawCredentials &&
    !rawCertificateDigests &&
    minimumVersionCode === undefined
  )
    return undefined;
  if (
    !packageName ||
    !rawCredentials ||
    !rawCertificateDigests ||
    minimumVersionCode === undefined
  ) {
    throw new Error(
      "PLAY_INTEGRITY package, credentials, certificate allowlist, and minimum version must be configured together",
    );
  }
  const allowedCertificateSha256Digests = rawCertificateDigests
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    allowedCertificateSha256Digests.length === 0 ||
    allowedCertificateSha256Digests.length > 8 ||
    new Set(allowedCertificateSha256Digests).size !==
      allowedCertificateSha256Digests.length ||
    allowedCertificateSha256Digests.some(
      (digest) => !/^[A-Za-z0-9_-]{43}$/u.test(digest),
    )
  ) {
    throw new Error(
      "PLAY_INTEGRITY_ALLOWED_CERTIFICATE_SHA256_DIGESTS must contain 1-8 unique unpadded base64url SHA-256 digests",
    );
  }
  let credentials: unknown;
  try {
    credentials = JSON.parse(rawCredentials) as unknown;
  } catch {
    throw new Error(
      "PLAY_INTEGRITY_GOOGLE_CREDENTIALS_JSON must be valid JSON",
    );
  }
  if (
    !credentials ||
    typeof credentials !== "object" ||
    Array.isArray(credentials)
  ) {
    throw new Error(
      "PLAY_INTEGRITY_GOOGLE_CREDENTIALS_JSON must contain a credential object",
    );
  }
  const credentialRecord = credentials as Record<string, unknown>;
  if (
    credentialRecord.type !== "service_account" &&
    credentialRecord.type !== "external_account"
  ) {
    throw new Error(
      "PLAY_INTEGRITY_GOOGLE_CREDENTIALS_JSON must use service_account or external_account credentials",
    );
  }
  if (
    credentialRecord.type === "service_account" &&
    (typeof credentialRecord.client_email !== "string" ||
      credentialRecord.client_email.length === 0 ||
      typeof credentialRecord.private_key !== "string" ||
      credentialRecord.private_key.length === 0)
  ) {
    throw new Error(
      "PLAY_INTEGRITY_GOOGLE_CREDENTIALS_JSON service account credentials are incomplete",
    );
  }
  if (
    credentialRecord.type === "external_account" &&
    (typeof credentialRecord.audience !== "string" ||
      credentialRecord.audience.length === 0 ||
      typeof credentialRecord.subject_token_type !== "string" ||
      credentialRecord.subject_token_type.length === 0 ||
      typeof credentialRecord.token_url !== "string" ||
      !credentialRecord.token_url.startsWith("https://") ||
      !credentialRecord.credential_source ||
      typeof credentialRecord.credential_source !== "object")
  ) {
    throw new Error(
      "PLAY_INTEGRITY_GOOGLE_CREDENTIALS_JSON external account credentials are incomplete",
    );
  }
  return {
    packageName,
    googleCredentials: credentialRecord,
    allowedCertificateSha256Digests,
    minimumVersionCode,
    providerTimeoutMs: parsed.PLAY_INTEGRITY_PROVIDER_TIMEOUT_MS,
    maxTokenAgeMs: parsed.PLAY_INTEGRITY_MAX_TOKEN_AGE_MS,
  };
}

function validatePublicOrigin(name: string, value: string): void {
  const parsed = new URL(value);
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `${name} must be an origin without credentials, path, query, or fragment`,
    );
  }
}

function parseTrustedProxyCidrs(value: string): false | string[] {
  if (value.trim() === "false") return false;
  if (value.trim() === "true") {
    throw new Error(
      "TRUST_PROXY cannot trust every address; provide explicit proxy CIDRs",
    );
  }

  const cidrs = value
    .split(",")
    .map((cidr) => cidr.trim())
    .filter(Boolean);
  if (cidrs.length === 0) {
    throw new Error("TRUST_PROXY must be false or a comma-separated CIDR list");
  }

  for (const cidr of cidrs) {
    const separator = cidr.lastIndexOf("/");
    const address = separator > 0 ? cidr.slice(0, separator) : "";
    const prefixText = cidr.slice(separator + 1);
    const prefix = Number(prefixText);
    const family = isIP(address);
    const maximumPrefix = family === 4 ? 32 : family === 6 ? 128 : -1;
    if (
      separator <= 0 ||
      !/^\d{1,3}$/u.test(prefixText) ||
      !Number.isInteger(prefix) ||
      prefix <= 0 ||
      prefix > maximumPrefix
    ) {
      throw new Error(`TRUST_PROXY contains an invalid CIDR: ${cidr}`);
    }
  }
  return cidrs;
}

export function validateDatabaseTransport(
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

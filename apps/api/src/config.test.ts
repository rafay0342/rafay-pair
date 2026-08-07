import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

const productionAppAttestEnvironment = {
  APP_ATTEST_TEAM_ID: "ABCDEFGHIJ",
  APP_ATTEST_BUNDLE_ID: "com.rafaypair.ios",
  APP_ATTEST_ENVIRONMENT: "production",
  APP_ATTEST_ALLOWED_VALIDATION_CATEGORIES: "1",
  APP_ATTEST_ALLOWED_BUNDLE_VERSIONS: "1.0.0",
};
const productionDatabaseCaEnvironment = {
  DATABASE_CA_CERT_PATH: "/app/certs/aws-rds-global-bundle.pem",
};

describe("production configuration", () => {
  it("requires encrypted transports and a separate device-token key", () => {
    const base = {
      ...productionAppAttestEnvironment,
      ...productionDatabaseCaEnvironment,
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://database.example.test/rafay_pair",
      REDIS_URL: "rediss://redis.example.test:6379",
      SESSION_PEPPER: "session-pepper-at-least-thirty-two-random-bytes",
      EMAIL_TOKEN_PEPPER: "join-code-pepper-at-least-thirty-two-random-bytes",
      PUBLIC_API_URL: "https://api.rafaypair.com",
      PUBLIC_WEB_ORIGIN: "https://app.rafaypair.com",
      ALLOWED_ORIGINS: "https://app.rafaypair.com",
      PLAY_INTEGRITY_PACKAGE_NAME: "com.rafaypair.android",
      PLAY_INTEGRITY_GOOGLE_CREDENTIALS_JSON: JSON.stringify({
        type: "service_account",
        client_email: "integrity@example.test",
        private_key: "test-only-not-a-real-key",
      }),
      PLAY_INTEGRITY_ALLOWED_CERTIFICATE_SHA256_DIGESTS: "a".repeat(43),
      PLAY_INTEGRITY_MIN_VERSION_CODE: "1",
    };
    expect(() => loadConfig(base)).toThrow("DEVICE_TOKEN_ENCRYPTION_KEY");
    expect(() =>
      loadConfig({
        ...base,
        DEVICE_TOKEN_ENCRYPTION_KEY: "a".repeat(43),
        REDIS_URL: "redis://redis.example.test:6379",
      }),
    ).toThrow("rediss://");
    expect(
      loadConfig({
        ...base,
        DEVICE_TOKEN_ENCRYPTION_KEY: "a".repeat(43),
      }).publicApiUrl,
    ).toBe("https://api.rafaypair.com");
    expect(
      loadConfig({
        ...base,
        DEVICE_TOKEN_ENCRYPTION_KEY: "a".repeat(43),
      }).publicWebOrigin,
    ).toBe("https://app.rafaypair.com");
    expect(() =>
      loadConfig({
        ...base,
        PUBLIC_WEB_ORIGIN: "http://app.rafaypair.com",
        DEVICE_TOKEN_ENCRYPTION_KEY: "a".repeat(43),
      }),
    ).toThrow("PUBLIC_WEB_ORIGIN");
    expect(() =>
      loadConfig({
        ...base,
        DEVICE_TOKEN_ENCRYPTION_KEY: "a".repeat(43),
        TRUST_PROXY: "true",
      }),
    ).toThrow("explicit proxy CIDRs");
    expect(
      loadConfig({
        ...base,
        DEVICE_TOKEN_ENCRYPTION_KEY: "a".repeat(43),
        TRUST_PROXY: "10.42.0.0/16, 54.240.0.0/16",
      }).trustProxy,
    ).toEqual(["10.42.0.0/16", "54.240.0.0/16"]);
    for (const trustProxy of ["1.2.3.4/", "0.0.0.0/0", "::/0"]) {
      expect(() =>
        loadConfig({
          ...base,
          DEVICE_TOKEN_ENCRYPTION_KEY: "a".repeat(43),
          TRUST_PROXY: trustProxy,
        }),
      ).toThrow("invalid CIDR");
    }
    for (const query of [
      "sslmode=no-verify",
      "sslmode=require",
      "uselibpqcompat=true&sslmode=require",
      "ssl=no-verify",
    ]) {
      expect(() =>
        loadConfig({
          ...base,
          DATABASE_URL: `postgresql://database.example.test/rafay_pair?${query}`,
          DEVICE_TOKEN_ENCRYPTION_KEY: "a".repeat(43),
        }),
      ).toThrow(/DATABASE_URL/u);
    }
  });

  it("fails closed on missing or unsafe Play Integrity provider configuration", () => {
    const base = {
      ...productionAppAttestEnvironment,
      ...productionDatabaseCaEnvironment,
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://database.example.test/rafay_pair",
      REDIS_URL: "rediss://redis.example.test:6379",
      SESSION_PEPPER: "session-pepper-at-least-thirty-two-random-bytes",
      EMAIL_TOKEN_PEPPER: "join-code-pepper-at-least-thirty-two-random-bytes",
      DEVICE_TOKEN_ENCRYPTION_KEY: "a".repeat(43),
      PUBLIC_API_URL: "https://api.rafaypair.com",
      PUBLIC_WEB_ORIGIN: "https://app.rafaypair.com",
      ALLOWED_ORIGINS: "https://app.rafaypair.com",
    };
    expect(() => loadConfig(base)).toThrow("PLAY_INTEGRITY");
    expect(() =>
      loadConfig({
        ...base,
        PLAY_INTEGRITY_PACKAGE_NAME: "com.rafaypair.android",
        PLAY_INTEGRITY_GOOGLE_CREDENTIALS_JSON: JSON.stringify({
          type: "authorized_user",
        }),
        PLAY_INTEGRITY_ALLOWED_CERTIFICATE_SHA256_DIGESTS: "a".repeat(43),
        PLAY_INTEGRITY_MIN_VERSION_CODE: "1",
      }),
    ).toThrow("service_account or external_account");
    expect(() =>
      loadConfig({
        ...base,
        PLAY_INTEGRITY_PACKAGE_NAME: "com.rafaypair.android",
        PLAY_INTEGRITY_GOOGLE_CREDENTIALS_JSON: "not-json",
        PLAY_INTEGRITY_ALLOWED_CERTIFICATE_SHA256_DIGESTS: "a".repeat(43),
        PLAY_INTEGRITY_MIN_VERSION_CODE: "1",
      }),
    ).toThrow("valid JSON");
    expect(() =>
      loadConfig({
        ...base,
        PLAY_INTEGRITY_PACKAGE_NAME: "com.rafaypair.android",
        PLAY_INTEGRITY_GOOGLE_CREDENTIALS_JSON: JSON.stringify({
          type: "service_account",
          client_email: "integrity@example.test",
          private_key: "test-only-not-a-real-key",
        }),
        PLAY_INTEGRITY_ALLOWED_CERTIFICATE_SHA256_DIGESTS: "not-a-digest",
        PLAY_INTEGRITY_MIN_VERSION_CODE: "1",
      }),
    ).toThrow("base64url SHA-256");
  });

  it("bounds realtime distributed limits and rejects contradictory scopes", () => {
    const base = {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://localhost/rafay_pair",
      REDIS_URL: "redis://localhost:6379",
      SESSION_PEPPER: "session-pepper-at-least-thirty-two-random-bytes",
      EMAIL_TOKEN_PEPPER: "join-code-pepper-at-least-thirty-two-random-bytes",
    };
    expect(loadConfig(base)).toMatchObject({
      realtimeMaxConnectionsPerUser: 4,
      realtimeMaxConnectionsPerSession: 2,
      realtimeReplayPageSize: 100,
      realtimeMaxBufferedEvents: 1_000,
      realtimeMaxSocketBufferBytes: 1_048_576,
    });
    expect(() =>
      loadConfig({
        ...base,
        REALTIME_MAX_CONNECTIONS_PER_USER: "1",
        REALTIME_MAX_CONNECTIONS_PER_SESSION: "2",
      }),
    ).toThrow("cannot exceed");
    expect(() =>
      loadConfig({ ...base, REALTIME_REPLAY_PAGE_SIZE: "501" }),
    ).toThrow();
  });

  it("requires an absolute database trust bundle path in production", () => {
    const base = {
      ...productionAppAttestEnvironment,
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://database.example.test/rafay_pair",
      REDIS_URL: "rediss://redis.example.test:6379",
      SESSION_PEPPER: "session-pepper-at-least-thirty-two-random-bytes",
      EMAIL_TOKEN_PEPPER: "join-code-pepper-at-least-thirty-two-random-bytes",
      DEVICE_TOKEN_ENCRYPTION_KEY: "a".repeat(43),
      PUBLIC_API_URL: "https://api.rafaypair.com",
      PUBLIC_WEB_ORIGIN: "https://app.rafaypair.com",
      ALLOWED_ORIGINS: "https://app.rafaypair.com",
      PLAY_INTEGRITY_PACKAGE_NAME: "com.rafaypair.android",
      PLAY_INTEGRITY_GOOGLE_CREDENTIALS_JSON: JSON.stringify({
        type: "service_account",
        client_email: "integrity@example.test",
        private_key: "test-only-not-a-real-key",
      }),
      PLAY_INTEGRITY_ALLOWED_CERTIFICATE_SHA256_DIGESTS: "a".repeat(43),
      PLAY_INTEGRITY_MIN_VERSION_CODE: "1",
    };
    expect(() => loadConfig(base)).toThrow("DATABASE_CA_CERT_PATH");
    expect(() =>
      loadConfig({ ...base, DATABASE_CA_CERT_PATH: "relative/ca.pem" }),
    ).toThrow("absolute path");
    expect(
      loadConfig({
        ...base,
        ...productionDatabaseCaEnvironment,
      }).databaseCaCertificatePath,
    ).toBe("/app/certs/aws-rds-global-bundle.pem");
  });

  it("fails closed on incomplete or unsafe App Attest policy", () => {
    const base = {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://localhost/rafay_pair",
      REDIS_URL: "redis://localhost:6379",
      SESSION_PEPPER: "session-pepper-at-least-thirty-two-random-bytes",
      EMAIL_TOKEN_PEPPER: "join-code-pepper-at-least-thirty-two-random-bytes",
    };
    expect(() =>
      loadConfig({ ...base, APP_ATTEST_TEAM_ID: "ABCDEFGHIJ" }),
    ).toThrow("configured together");
    expect(() =>
      loadConfig({
        ...productionDatabaseCaEnvironment,
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://database.example.test/rafay_pair",
        REDIS_URL: "rediss://redis.example.test:6379",
        SESSION_PEPPER: "session-pepper-at-least-thirty-two-random-bytes",
        EMAIL_TOKEN_PEPPER: "join-code-pepper-at-least-thirty-two-random-bytes",
        DEVICE_TOKEN_ENCRYPTION_KEY: "a".repeat(43),
        PUBLIC_API_URL: "https://api.rafaypair.com",
        PUBLIC_WEB_ORIGIN: "https://app.rafaypair.com",
        ALLOWED_ORIGINS: "https://app.rafaypair.com",
        PLAY_INTEGRITY_PACKAGE_NAME: "com.rafaypair.android",
        PLAY_INTEGRITY_GOOGLE_CREDENTIALS_JSON: JSON.stringify({
          type: "service_account",
          client_email: "integrity@example.test",
          private_key: "test-only-not-a-real-key",
        }),
        PLAY_INTEGRITY_ALLOWED_CERTIFICATE_SHA256_DIGESTS: "a".repeat(43),
        PLAY_INTEGRITY_MIN_VERSION_CODE: "1",
      }),
    ).toThrow("APP_ATTEST");
    expect(
      loadConfig({
        ...base,
        ...productionAppAttestEnvironment,
      }).appAttest,
    ).toMatchObject({
      appId: "ABCDEFGHIJ.com.rafaypair.ios",
      environment: "production",
    });
    expect(() =>
      loadConfig({
        ...base,
        ...productionAppAttestEnvironment,
        APP_ATTEST_ALLOWED_VALIDATION_CATEGORIES: "0,1",
      }),
    ).toThrow("integers from 1 through 6");
    expect(() =>
      loadConfig({
        ...base,
        ...productionAppAttestEnvironment,
        APP_ATTEST_ALLOWED_BUNDLE_VERSIONS: "1.0.0,1.0.0",
      }),
    ).toThrow("unique release versions");
  });
});

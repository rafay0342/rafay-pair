import { describe, expect, it } from "vitest";

import { loadWorkerConfig } from "./config.js";

const productionEnvironment = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://database.example.test/rafay_pair",
  DATABASE_CA_CERT_PATH: "/app/certs/aws-rds-global-bundle.pem",
  REDIS_URL: "rediss://redis.example.test:6379",
  SESSION_PEPPER: "worker-session-pepper-at-least-thirty-two-bytes",
  DEVICE_TOKEN_ENCRYPTION_KEY: "a".repeat(43),
  APNS_TEAM_ID: "TEAM123456",
  APNS_KEY_ID: "KEY1234567",
  APNS_BUNDLE_ID: "com.rafaypair.app",
  APNS_PRIVATE_KEY: "test-apns-private-key",
  FCM_PROJECT_ID: "rafay-pair-test",
  FCM_CLIENT_EMAIL: "firebase@rafay-pair-test.iam.gserviceaccount.com",
  FCM_PRIVATE_KEY: "test-fcm-private-key",
};

describe("worker database transport configuration", () => {
  it("rejects connection-string options that can weaken verified TLS", () => {
    for (const query of [
      "sslmode=disable",
      "sslmode=no-verify",
      "sslmode=require",
      "uselibpqcompat=true&sslmode=require",
      "ssl=no-verify",
    ]) {
      expect(() =>
        loadWorkerConfig({
          ...productionEnvironment,
          DATABASE_URL: `postgresql://database.example.test/rafay_pair?${query}`,
        }),
      ).toThrow(/DATABASE_URL/u);
    }
  });

  it("accepts verified TLS and rejects non-PostgreSQL URLs", () => {
    expect(
      loadWorkerConfig({
        ...productionEnvironment,
        DATABASE_URL:
          "postgresql://database.example.test/rafay_pair?sslmode=verify-full",
      }).databaseUrl,
    ).toContain("sslmode=verify-full");
    expect(() =>
      loadWorkerConfig({
        ...productionEnvironment,
        DATABASE_URL: "https://database.example.test/rafay_pair",
      }),
    ).toThrow("postgres protocol");
  });

  it("requires an absolute production database trust bundle path", () => {
    expect(() =>
      loadWorkerConfig({
        ...productionEnvironment,
        DATABASE_CA_CERT_PATH: undefined,
      }),
    ).toThrow("DATABASE_CA_CERT_PATH");
    expect(() =>
      loadWorkerConfig({
        ...productionEnvironment,
        DATABASE_CA_CERT_PATH: "relative/ca.pem",
      }),
    ).toThrow("absolute path");
  });

  it("fails closed when either native push provider is absent", () => {
    expect(() =>
      loadWorkerConfig({
        ...productionEnvironment,
        APNS_TEAM_ID: undefined,
        APNS_KEY_ID: undefined,
        APNS_BUNDLE_ID: undefined,
        APNS_PRIVATE_KEY: undefined,
      }),
    ).toThrow("APNs");
    expect(() =>
      loadWorkerConfig({
        ...productionEnvironment,
        FCM_PROJECT_ID: undefined,
        FCM_CLIENT_EMAIL: undefined,
        FCM_PRIVATE_KEY: undefined,
      }),
    ).toThrow("FCM");
  });
});

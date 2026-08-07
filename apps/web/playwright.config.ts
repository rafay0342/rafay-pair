import { defineConfig, devices } from "@playwright/test";

const port = 5173;
const apiUrl = process.env.RAFAYPAIR_E2E_API_URL ?? "http://127.0.0.1:3000";
const deployedWebUrl = process.env.RAFAYPAIR_E2E_BASE_URL;
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://rafay_pair:local-development-only@127.0.0.1:5432/rafay_pair?sslmode=disable";
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const sessionPepper =
  process.env.SESSION_PEPPER ??
  "e2e-session-pepper-never-use-in-production-0001";

const localWebServer = {
  command: `pnpm dev --host 127.0.0.1 --port ${String(port)}`,
  url: `http://127.0.0.1:${String(port)}`,
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
  env: {
    ...process.env,
    VITE_API_BASE_URL: apiUrl,
  },
};

const localApiServer = {
  command:
    "pnpm --filter @rafay-pair/api migrate && pnpm --filter @rafay-pair/api dev",
  url: `${apiUrl}/health/ready`,
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
  cwd: "../..",
  env: {
    ...process.env,
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: "3000",
    ALLOWED_ORIGINS: `http://127.0.0.1:${String(port)}`,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    SESSION_PEPPER: sessionPepper,
    EMAIL_TOKEN_PEPPER:
      process.env.EMAIL_TOKEN_PEPPER ??
      "e2e-join-code-pepper-never-use-in-production-01",
    LOG_LEVEL: "warn",
  },
};

const localWorkerServer = {
  command:
    "pnpm --filter @rafay-pair/api migrate && pnpm --filter @rafay-pair/worker dev",
  url: "http://127.0.0.1:3001/health/ready",
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
  cwd: "../..",
  env: {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    SESSION_PEPPER: sessionPepper,
    WORKER_HEALTH_PORT: "3001",
    LOG_LEVEL: "warn",
  },
};

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "list",
  use: {
    baseURL: deployedWebUrl ?? `http://127.0.0.1:${String(port)}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-safari", use: { ...devices["iPhone 15"] } },
  ],
  ...(deployedWebUrl
    ? {}
    : {
        webServer: process.env.RAFAYPAIR_E2E_API_URL
          ? localWebServer
          : [localApiServer, localWorkerServer, localWebServer],
      }),
});

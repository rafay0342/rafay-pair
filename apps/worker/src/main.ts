import "./telemetry.js";

import { createServer } from "node:http";

import pg from "pg";
import pino from "pino";

import {
  ApnsProvider,
  FcmProvider,
  NotificationDispatcher,
} from "@rafay-pair/notifications";
import { createRedisClient, RealtimeBroker } from "@rafay-pair/realtime";

import { loadWorkerConfig, loadWorkerDatabaseCaCertificate } from "./config.js";
import { OutboxProcessor } from "./processor.js";
import { shutdownTelemetry } from "./telemetry.js";

const config = loadWorkerConfig();
const logger = pino({ level: config.logLevel });
const databaseCaCertificate = await loadWorkerDatabaseCaCertificate(
  config.databaseCaCertificatePath,
);
const parsedDatabaseUrl = new URL(config.databaseUrl);
const databaseTlsDisabled =
  parsedDatabaseUrl.searchParams.get("sslmode") === "disable";
for (const option of [
  "sslmode",
  "ssl",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "uselibpqcompat",
]) {
  parsedDatabaseUrl.searchParams.delete(option);
}
const pool = new pg.Pool({
  connectionString: parsedDatabaseUrl.toString(),
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  ssl: databaseTlsDisabled
    ? false
    : {
        rejectUnauthorized: true,
        ...(databaseCaCertificate ? { ca: databaseCaCertificate } : {}),
      },
});
const redis = createRedisClient(config.redisUrl);
await redis.connect();
const broker = new RealtimeBroker(redis);
await broker.connect();
const notifications = new NotificationDispatcher(
  config.apns ? new ApnsProvider(config.apns) : undefined,
  config.fcm ? new FcmProvider(config.fcm) : undefined,
);
const processor = new OutboxProcessor(
  pool,
  broker,
  notifications,
  config,
  logger,
);

let stopping = false;
let timer: NodeJS.Timeout | undefined;
let lastPollAt = new Date();

const poll = async (): Promise<void> => {
  if (stopping) return;
  try {
    let processed: number;
    do {
      processed = await processor.processAvailable();
      lastPollAt = new Date();
    } while (processed > 0 && !stopping);
  } catch (error) {
    logger.error({ err: error }, "worker poll failed");
  } finally {
    if (!stopping) timer = setTimeout(() => void poll(), config.pollIntervalMs);
  }
};

const healthServer = createServer(async (request, response) => {
  if (request.url === "/health/live") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}');
    return;
  }
  if (request.url === "/health/ready") {
    try {
      await pool.query("SELECT 1");
      await redis.ping();
      const fresh =
        Date.now() - lastPollAt.getTime() <
        Math.max(config.pollIntervalMs * 10, 30_000);
      response.writeHead(fresh ? 200 : 503, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ status: fresh ? "ready" : "stale" }));
    } catch {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"status":"unavailable"}');
    }
    return;
  }
  response.writeHead(404).end();
});

healthServer.listen(config.healthPort, "0.0.0.0", () => {
  logger.info(
    { port: config.healthPort, workerId: config.workerId },
    "worker health server listening",
  );
});
void poll();

const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  logger.info({ signal }, "worker shutting down");
  await new Promise<void>((resolve, reject) => {
    healthServer.close((error) => (error ? reject(error) : resolve()));
  });
  await broker.close();
  await pool.end();
  await shutdownTelemetry();
};

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

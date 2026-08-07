import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";

import {
  realtimeApplicationProtocol,
  realtimeTicketProtocolPrefix,
  realtimeTicketSchema,
} from "@rafay-pair/api-contracts";
import {
  createRedisClient,
  type ConnectionLeaseStore,
  RealtimeBroker,
  RealtimeConnectionLeaseStore,
  RealtimeTicketStore,
} from "@rafay-pair/realtime";

import type { ApiConfig } from "./config.js";
import { createDatabasePool, loadDatabaseCaCertificate } from "./database.js";
import { sendProblem } from "./errors.js";
import {
  GooglePlayIntegrityVerifier,
  type PlayIntegrityVerifier,
} from "./play-integrity.js";
import { createRedisRateLimitStore } from "./redis-rate-limit-store.js";
import { registerAndroidIntegrityRoutes } from "./routes/android-integrity-routes.js";
import { registerAuthRoutes } from "./routes/auth-routes.js";
import { registerCareRoutes } from "./routes/care-routes.js";
import { registerConsentRoutes } from "./routes/consent-routes.js";
import { registerNotificationDeviceRoutes } from "./routes/notification-device-routes.js";
import { registerPairRoutes } from "./routes/pair-routes.js";
import { registerPrivacyRoutes } from "./routes/privacy-routes.js";
import { registerRealtimeRoutes } from "./routes/realtime-routes.js";
import { registerIosIntegrityRoutes } from "./routes/ios-integrity-routes.js";

export interface BuildApiOptions {
  config: ApiConfig;
  pool?: Pool;
  realtimeBroker?: RealtimeBroker;
  ticketStore?: RealtimeTicketStore;
  connectionLeaseStore?: ConnectionLeaseStore;
  playIntegrityVerifier?: PlayIntegrityVerifier;
}

export async function buildApi(
  options: BuildApiOptions,
): Promise<FastifyInstance> {
  const { config } = options;
  if (
    config.nodeEnv === "production" &&
    (!config.publicApiUrl || !config.publicWebOrigin)
  ) {
    throw new Error(
      "PUBLIC_API_URL and PUBLIC_WEB_ORIGIN are required in production",
    );
  }
  const pool =
    options.pool ??
    createDatabasePool(
      config.databaseUrl,
      await loadDatabaseCaCertificate(config.databaseCaCertificatePath),
    );
  const redis =
    options.realtimeBroker &&
    options.ticketStore &&
    options.connectionLeaseStore
      ? undefined
      : createRedisClient(config.redisUrl);
  if (redis) await redis.connect();
  const realtimeBroker = options.realtimeBroker ?? new RealtimeBroker(redis!);
  if (!options.realtimeBroker) await realtimeBroker.connect();
  const ticketStore =
    options.ticketStore ??
    new RealtimeTicketStore(redis!, {
      maxPendingPerUser: config.realtimeMaxTicketsPerUserWindow,
      maxPendingPerSession: config.realtimeMaxTicketsPerSessionWindow,
    });
  const connectionLeaseStore =
    options.connectionLeaseStore ??
    new RealtimeConnectionLeaseStore(redis!, {
      ttlSeconds: config.realtimeConnectionLeaseTtlSeconds,
      maxConnectionsPerUser: config.realtimeMaxConnectionsPerUser,
      maxConnectionsPerSession: config.realtimeMaxConnectionsPerSession,
    });
  const playIntegrityVerifier =
    options.playIntegrityVerifier ??
    (config.playIntegrity
      ? new GooglePlayIntegrityVerifier({
          packageName: config.playIntegrity.packageName,
          googleCredentials: config.playIntegrity.googleCredentials,
          timeoutMs: config.playIntegrity.providerTimeoutMs,
        })
      : undefined);
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.sec-websocket-protocol",
        "req.body.integrityToken",
        "req.body.keyId",
        "req.body.attestationObject",
        "req.body.assertionObject",
        "res.headers.set-cookie",
      ],
    },
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1_024,
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  app.decorate("dependencies", {
    config,
    pool,
    realtimeBroker,
    ticketStore,
    connectionLeaseStore,
    ...(playIntegrityVerifier ? { playIntegrityVerifier } : {}),
  });

  await app.register(cookie);
  await app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      callback(
        null,
        origin === undefined || config.allowedOrigins.includes(origin),
      );
    },
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "X-CSRF-Token",
      "X-Rafay-Client",
      "X-Request-Id",
    ],
    exposedHeaders: ["X-Request-Id"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    maxAge: 600,
  });
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    ban: 3,
    keyGenerator: (request) => request.ip,
    skipOnError: false,
    ...(redis
      ? {
          store: createRedisRateLimitStore(redis, config.sessionPepper),
        }
      : {}),
  });
  await app.register(websocket, {
    options: {
      maxPayload: 16 * 1_024,
      perMessageDeflate: false,
      handleProtocols(protocols: Set<string>) {
        if (
          protocols.size !== 2 ||
          !protocols.has(realtimeApplicationProtocol)
        ) {
          return false;
        }
        const ticketProtocols = [...protocols].filter((protocol) =>
          protocol.startsWith(realtimeTicketProtocolPrefix),
        );
        const ticket = ticketProtocols[0]?.slice(
          realtimeTicketProtocolPrefix.length,
        );
        if (
          ticketProtocols.length !== 1 ||
          !realtimeTicketSchema.safeParse(ticket).success
        ) {
          return false;
        }
        return realtimeApplicationProtocol;
      },
    },
  });

  app.setErrorHandler(sendProblem);
  app.setNotFoundHandler((request, reply) => {
    sendProblem({ statusCode: 404 }, request, reply);
  });
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.id);
    reply.header("cache-control", "no-store");
    return payload;
  });

  const requestSpans = new WeakMap<object, Span>();
  const tracer = trace.getTracer("rafay-pair-api");
  app.addHook("onRequest", async (request) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    const span = tracer.startSpan(`${request.method} ${path}`);
    span.setAttribute("http.request.method", request.method);
    span.setAttribute("url.path", path);
    requestSpans.set(request, span);
  });
  app.addHook("onError", async (request, _reply, error) => {
    const span = requestSpans.get(request);
    span?.recordException(error);
    span?.setStatus({ code: SpanStatusCode.ERROR });
  });
  app.addHook("onResponse", async (request, reply) => {
    const span = requestSpans.get(request);
    if (!span) return;
    span.setAttribute("http.response.status_code", reply.statusCode);
    span.setStatus({
      code: reply.statusCode >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK,
    });
    span.end();
    requestSpans.delete(request);
  });

  const liveHealthHandler = async () => ({ status: "ok" as const });
  const readyHealthHandler = async (
    _request: unknown,
    reply: { send: (body: { status: "ready" }) => unknown },
  ) => {
    await pool.query("SELECT 1");
    if (redis) await redis.ping();
    return reply.send({ status: "ready" });
  };
  app.get("/health/live", liveHealthHandler);
  app.get("/health/ready", readyHealthHandler);
  // CloudFront forwards only /v1/* to the API. Keep the ALB/container paths
  // above and expose exact aliases for protected Web release verification.
  app.get("/v1/health/live", liveHealthHandler);
  app.get("/v1/health/ready", readyHealthHandler);
  app.get("/openapi.yaml", async (_request, reply) => {
    const specificationPath = createRequire(import.meta.url).resolve(
      "@rafay-pair/api-contracts/openapi.yaml",
    );
    const specification = await readFile(specificationPath, "utf8");
    return reply.type("application/yaml; charset=utf-8").send(specification);
  });

  await registerAuthRoutes(app);
  await registerPairRoutes(app);
  await registerConsentRoutes(app);
  await registerCareRoutes(app);
  await registerPrivacyRoutes(app);
  await registerNotificationDeviceRoutes(app);
  await registerAndroidIntegrityRoutes(app);
  await registerIosIntegrityRoutes(app);
  await registerRealtimeRoutes(app);

  app.addHook("onClose", async () => {
    if (!options.realtimeBroker) await realtimeBroker.close();
    else if (redis?.isOpen) await redis.close();
    if (!options.pool) await pool.end();
  });
  return app;
}

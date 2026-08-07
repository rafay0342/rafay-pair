import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";

import {
  realtimeApplicationProtocol,
  realtimeEventEnvelopeSchema,
  realtimeTicketProtocolPrefix,
  realtimeTicketRequestSchema,
  realtimeTicketSchema,
  type RealtimeEventEnvelope,
} from "@rafay-pair/api-contracts";
import { directionalConsentForEvent } from "@rafay-pair/event-contracts";
import { RealtimeCapacityError, type TicketClaims } from "@rafay-pair/realtime";
import {
  SessionAuthorizationError,
  SessionCoordinator,
} from "@rafay-pair/session-coordinator";

import { mutationGuard } from "../guards.js";
import { ApiError } from "../errors.js";
import { authenticated } from "../types.js";

const sessionReauthorizationIntervalMs = 5_000;
const controlEventTypes = new Set<RealtimeEventEnvelope["type"]>([
  "privacy.paused",
  "privacy.resumed",
  "pair.disconnected",
]);

interface RealtimeRow {
  id: string;
  event_uuid: string;
  event_type: RealtimeEventEnvelope["type"];
  payload: Record<string, unknown>;
  occurred_at: Date;
  authorization_revision: string;
}

interface AuthorizationFenceRow {
  session_valid: boolean;
  pair_status: string;
  authorization_revision: string;
  viewer_active: boolean;
  active_members: number;
  paused: boolean;
}

interface ConsentRow {
  grantor_user_id: string;
  grantee_user_id: string;
  capability: string;
  granted: boolean;
  updated_at: Date;
}

type EventAuthorization =
  "allowed" | "consent_denied" | "session_revoked" | "sharing_unavailable";

export async function registerRealtimeRoutes(
  app: FastifyInstance,
): Promise<void> {
  const dependencies = app.dependencies;
  const { config, pool, realtimeBroker, ticketStore, connectionLeaseStore } =
    dependencies;

  const ticketHandler = async (
    request: FastifyRequest,
    reply: import("fastify").FastifyReply,
  ) => {
    const auth = authenticated(request);
    const body = realtimeTicketRequestSchema.parse(request.body ?? {});
    const pair = await new SessionCoordinator(pool).getActivePair(auth.userId);
    if (pair.actorPaused || pair.partnerPaused)
      throw new SessionAuthorizationError("PRIVACY_PAUSED");
    let issued: Awaited<ReturnType<typeof ticketStore.issue>>;
    try {
      issued = await withTimeout(
        ticketStore.issue({
          userId: auth.userId,
          sessionId: auth.sessionId,
          pairId: pair.pairId,
          ...(body.lastEventId ? { lastEventId: body.lastEventId } : {}),
        }),
        5_000,
      );
    } catch (error) {
      if (!(error instanceof RealtimeCapacityError)) throw error;
      request.log.warn(
        { scope: error.scope },
        "realtime ticket capacity denied",
      );
      reply.header("retry-after", "30");
      throw new ApiError(
        429,
        "REALTIME_CAPACITY_EXCEEDED",
        "Realtime connection capacity exceeded",
        "Wait for the realtime ticket issuance window to reset before retrying.",
      );
    }
    const configuredBase =
      auth.platform === "web" ? config.publicWebOrigin : config.publicApiUrl;
    const base =
      configuredBase ??
      `${request.protocol}://${request.hostname}${config.port === 80 || config.port === 443 ? "" : `:${config.port}`}`;
    const websocketUrl = new URL("/v1/realtime", base);
    websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
    return reply.send({ ...issued, webSocketUrl: websocketUrl.toString() });
  };

  app.post(
    "/v1/realtime/tickets",
    { preHandler: mutationGuard(dependencies) },
    ticketHandler,
  );
  app.post(
    "/v1/realtime/ticket",
    { preHandler: mutationGuard(dependencies) },
    ticketHandler,
  );

  app.get("/v1/realtime", { websocket: true }, async (socket, request) => {
    socket.on("message", () => {
      if (socket.readyState === 1)
        socket.close(1008, "client messages are not supported");
    });
    if (request.url.includes("?")) {
      socket.close(1008, "query credentials are forbidden");
      return;
    }
    const ticket = realtimeTicketFromProtocolHeader(
      request.headers["sec-websocket-protocol"],
    );
    if (!ticket || socket.protocol !== realtimeApplicationProtocol) {
      socket.close(1008, "valid realtime protocols required");
      return;
    }
    const claims = await ticketStore.consume(ticket).catch(() => null);
    if (!claims) {
      socket.close(1008, "invalid or consumed ticket");
      return;
    }
    let initiallyAuthorized = false;
    try {
      initiallyAuthorized = await withTimeout(
        connectionIsAuthorized(pool, claims),
        5_000,
      );
    } catch (error) {
      request.log.error(
        { err: error },
        "realtime initial authorization failed",
      );
      socket.close(1013, "authorization unavailable");
      return;
    }
    if (!initiallyAuthorized) {
      socket.close(1008, "session or sharing revoked");
      return;
    }

    let lease;
    try {
      lease = await withTimeout(
        connectionLeaseStore.acquire(claims.userId, claims.sessionId),
        5_000,
      );
    } catch (error) {
      request.log.warn(
        {
          reason:
            error instanceof RealtimeCapacityError
              ? `${error.scope}_capacity`
              : "lease_backend_unavailable",
        },
        "realtime connection lease denied",
      );
      socket.close(1013, "realtime capacity unavailable");
      return;
    }
    if (socket.readyState !== 1) {
      void connectionLeaseStore.release(lease).catch(() => undefined);
      return;
    }

    let buffering = true;
    let lastSentEventId = BigInt(claims.lastEventId ?? "0");
    let eventQueue = Promise.resolve();
    const buffered: RealtimeEventEnvelope[] = [];
    const deliverEvents = async (
      eventUuids: readonly string[],
      replay: boolean,
    ): Promise<void> => {
      if (socket.readyState !== 1 || eventUuids.length === 0) return;
      const authorization = await authorizeAndSendEvents(
        pool,
        claims,
        eventUuids,
        replay,
        (event) => {
          if (socket.readyState !== 1) return;
          const id = BigInt(event.eventId);
          if (id <= lastSentEventId) return;
          lastSentEventId = id;
          socket.send(JSON.stringify(event));
          if (
            event.type === "privacy.paused" ||
            event.type === "pair.disconnected"
          ) {
            socket.close(1000, event.type);
          }
        },
      );
      if (authorization === "session_revoked") {
        socket.close(1008, "session revoked");
        return;
      }
      if (authorization === "sharing_unavailable") {
        socket.close(1008, "sharing unavailable");
        return;
      }
      if (authorization === "consent_denied") return;
    };
    const pendingLive: RealtimeEventEnvelope[] = [];
    let queuedLiveEvents = 0;
    let liveFlushScheduled = false;
    const flushLive = (): void => {
      liveFlushScheduled = false;
      const events = pendingLive.splice(0, pendingLive.length);
      eventQueue = eventQueue
        .then(async () => {
          const uniqueEventUuids = [
            ...new Set(events.map((event) => event.id)),
          ];
          for (
            let offset = 0;
            offset < uniqueEventUuids.length && socket.readyState === 1;
            offset += config.realtimeReplayPageSize
          ) {
            await deliverEvents(
              uniqueEventUuids.slice(
                offset,
                offset + config.realtimeReplayPageSize,
              ),
              false,
            );
            if (
              !(await waitForSocketCapacity(
                socket,
                config.realtimeMaxSocketBufferBytes,
                () => request.log.warn("realtime socket backpressure timeout"),
              ))
            )
              break;
          }
        })
        .catch((error: unknown) => {
          request.log.error(
            { err: error },
            "realtime authorization batch failed",
          );
          socket.close(1011, "realtime authorization failed");
        })
        .finally(() => {
          queuedLiveEvents -= events.length;
        });
    };
    const enqueueEvent = (event: RealtimeEventEnvelope): void => {
      if (queuedLiveEvents >= config.realtimeMaxBufferedEvents) {
        request.log.warn("realtime live queue capacity exceeded");
        socket.close(1013, "realtime queue capacity exceeded");
        return;
      }
      queuedLiveEvents += 1;
      pendingLive.push(event);
      if (liveFlushScheduled) return;
      liveFlushScheduled = true;
      setImmediate(flushLive);
    };

    let alive = true;
    let authorizationCheckRunning = false;
    let unsubscribe = async (): Promise<void> => undefined;
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, 25_000);
    const durableAuthorization = setInterval(() => {
      if (authorizationCheckRunning || socket.readyState !== 1) return;
      authorizationCheckRunning = true;
      void withTimeout(connectionIsAuthorized(pool, claims), 5_000)
        .then((allowed) => {
          if (!allowed && socket.readyState === 1) {
            socket.close(1008, "session or sharing revoked");
          }
        })
        .catch(() => {
          if (socket.readyState === 1)
            socket.close(1011, "authorization check failed");
        })
        .finally(() => {
          authorizationCheckRunning = false;
        });
    }, sessionReauthorizationIntervalMs);
    let leaseRenewalRunning = false;
    const leaseRenewal = setInterval(() => {
      if (socket.readyState !== 1 || leaseRenewalRunning) return;
      leaseRenewalRunning = true;
      void withTimeout(
        connectionLeaseStore.renew(lease),
        Math.min(5_000, connectionLeaseStore.renewalIntervalMs),
      )
        .then((renewed) => {
          if (!renewed && socket.readyState === 1) {
            request.log.warn("realtime connection lease expired");
            socket.close(1013, "realtime lease expired");
          }
        })
        .catch((error: unknown) => {
          request.log.error(
            { err: error },
            "realtime connection lease renewal failed",
          );
          if (socket.readyState === 1)
            socket.close(1013, "realtime lease unavailable");
        })
        .finally(() => {
          leaseRenewalRunning = false;
        });
    }, connectionLeaseStore.renewalIntervalMs);
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      clearInterval(durableAuthorization);
      clearInterval(leaseRenewal);
      void unsubscribe().catch((error: unknown) => {
        request.log.warn({ err: error }, "realtime unsubscribe failed");
      });
      void connectionLeaseStore.release(lease).catch((error: unknown) => {
        request.log.warn(
          { err: error },
          "realtime connection lease release failed",
        );
      });
    };
    socket.on("pong", () => {
      alive = true;
    });
    socket.once("close", cleanup);
    socket.once("error", cleanup);
    if (socket.readyState !== 1) {
      cleanup();
      return;
    }

    try {
      // Subscribe before fixing the PostgreSQL high-water mark. Pub/Sub stays
      // transient; events arriving during replay are held in a bounded buffer.
      unsubscribe = await realtimeBroker.subscribe(claims.pairId, (event) => {
        if (buffering) {
          if (buffered.length >= config.realtimeMaxBufferedEvents) {
            request.log.warn("realtime replay buffer capacity exceeded");
            socket.close(1013, "realtime replay capacity exceeded");
            return;
          }
          buffered.push(event);
        } else enqueueEvent(event);
      });
      const highWaterResult = await pool.query<{ high_water: string }>(
        `
          SELECT COALESCE((
            SELECT event.id
            FROM realtime_events event
            JOIN outbox_events outbox ON outbox.event_uuid = event.event_uuid
            WHERE event.pair_id = $1 AND event.id > $2::bigint
              AND event.delivery_authorized_at IS NOT NULL
              AND event.delivery_authorized_revision = event.authorization_revision
              AND event.suppressed_at IS NULL
              AND outbox.dead_lettered_at IS NULL
            ORDER BY event.id DESC
            LIMIT 1
          ), $2::bigint)::text AS high_water
        `,
        [claims.pairId, claims.lastEventId ?? "0"],
      );
      const highWater = BigInt(
        highWaterResult.rows[0]?.high_water ?? claims.lastEventId ?? "0",
      );
      let cursor = BigInt(claims.lastEventId ?? "0");
      let replayPages = 0;
      let replayedEvents = 0;
      const replayStartedAt = Date.now();
      while (cursor < highWater && socket.readyState === 1) {
        const page = await pool.query<{ id: string; event_uuid: string }>(
          `
            WITH limited AS (
              SELECT event.id, event.event_uuid, event.payload
              FROM realtime_events event
              JOIN outbox_events outbox ON outbox.event_uuid = event.event_uuid
              WHERE event.pair_id = $1 AND event.id > $2::bigint
                AND event.id <= $3::bigint
                AND event.delivery_authorized_at IS NOT NULL
                AND event.delivery_authorized_revision = event.authorization_revision
                AND event.suppressed_at IS NULL
                AND outbox.dead_lettered_at IS NULL
              ORDER BY event.id
              LIMIT $4
            ), candidates AS (
              SELECT id, event_uuid,
                     row_number() OVER (ORDER BY id) AS sequence,
                     sum(pg_column_size(payload)) OVER (ORDER BY id)
                       AS cumulative_bytes
              FROM limited
            )
            SELECT id::text, event_uuid::text
            FROM candidates
            WHERE cumulative_bytes <= $5 OR sequence = 1
            ORDER BY id
          `,
          [
            claims.pairId,
            cursor.toString(),
            highWater.toString(),
            config.realtimeReplayPageSize,
            config.realtimeMaxSocketBufferBytes,
          ],
        );
        if (page.rows.length === 0) break;
        await deliverEvents(
          page.rows.map((row) => row.event_uuid),
          true,
        );
        if (
          !(await waitForSocketCapacity(
            socket,
            config.realtimeMaxSocketBufferBytes,
            () => request.log.warn("realtime socket backpressure timeout"),
          ))
        )
          return;
        cursor = BigInt(page.rows.at(-1)?.id ?? cursor.toString());
        replayPages += 1;
        replayedEvents += page.rows.length;
      }
      if (replayPages > 1) {
        request.log.info(
          {
            pages: replayPages,
            events: replayedEvents,
            durationMs: Date.now() - replayStartedAt,
          },
          "realtime replay completed",
        );
      }
      buffered.sort(compareEventIds);
      while (buffered.length > 0 && socket.readyState === 1) {
        const page = buffered.splice(0, config.realtimeReplayPageSize);
        await deliverEvents([...new Set(page.map((event) => event.id))], false);
        if (
          !(await waitForSocketCapacity(
            socket,
            config.realtimeMaxSocketBufferBytes,
            () => request.log.warn("realtime socket backpressure timeout"),
          ))
        )
          return;
      }
      buffering = false;
    } catch (error) {
      request.log.error({ err: error }, "realtime replay failed");
      cleanup();
      if (socket.readyState === 1) socket.close(1011, "realtime replay failed");
    }
  });
}

export function realtimeTicketFromProtocolHeader(
  header: string | string[] | undefined,
): string | null {
  if (typeof header !== "string") return null;
  const offered = header
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
  if (
    offered.length !== 2 ||
    new Set(offered).size !== 2 ||
    !offered.includes(realtimeApplicationProtocol)
  ) {
    return null;
  }
  const ticketProtocols = offered.filter((protocol) =>
    protocol.startsWith(realtimeTicketProtocolPrefix),
  );
  if (ticketProtocols.length !== 1) return null;
  const ticket = ticketProtocols[0]?.slice(realtimeTicketProtocolPrefix.length);
  const parsed = realtimeTicketSchema.safeParse(ticket);
  return parsed.success ? parsed.data : null;
}

async function connectionIsAuthorized(
  pool: Pool,
  claims: TicketClaims,
): Promise<boolean> {
  if (!(await sessionIsValid(pool, claims))) return false;
  const sharing = await pool.query<{ allowed: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM pairs pair
        JOIN pair_members viewer
          ON viewer.pair_id = pair.id AND viewer.user_id = $2
          AND viewer.left_at IS NULL
        WHERE pair.id = $1 AND pair.status = 'active'
          AND (
            SELECT count(*) FROM pair_members member
            WHERE member.pair_id = pair.id AND member.left_at IS NULL
          ) = 2
          AND NOT EXISTS (
            SELECT 1 FROM privacy_states privacy
            WHERE privacy.pair_id = pair.id AND privacy.paused = true
          )
      ) AS allowed
    `,
    [claims.pairId, claims.userId],
  );
  return sharing.rows[0]?.allowed === true;
}

async function sessionIsValid(
  pool: Pool | PoolClient,
  claims: TicketClaims,
): Promise<boolean> {
  const session = await pool.query<{ valid: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1 FROM auth_sessions session
        JOIN users owner ON owner.id = session.user_id
        WHERE session.id = $1 AND session.user_id = $2
          AND session.revoked_at IS NULL
          AND session.access_expires_at > now()
          AND session.refresh_expires_at > now()
          AND owner.disabled_at IS NULL
      ) AS valid
    `,
    [claims.sessionId, claims.userId],
  );
  return session.rows[0]?.valid === true;
}

async function authorizeAndSendEvents(
  pool: Pool,
  claims: TicketClaims,
  eventUuids: readonly string[],
  replay: boolean,
  send: (event: RealtimeEventEnvelope) => void,
): Promise<EventAuthorization> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '5s'",
    );
    const fence = await client.query<AuthorizationFenceRow>(
      `
        SELECT
          session.revoked_at IS NULL
          AND session.access_expires_at > now()
          AND session.refresh_expires_at > now()
          AND owner.disabled_at IS NULL AS session_valid,
          pair.status AS pair_status,
          pair.authorization_revision::text AS authorization_revision,
          EXISTS (
            SELECT 1 FROM pair_members viewer
            WHERE viewer.pair_id = pair.id AND viewer.user_id = $2
              AND viewer.left_at IS NULL
          ) AS viewer_active,
          (
            SELECT count(*)::integer FROM pair_members member
            WHERE member.pair_id = pair.id AND member.left_at IS NULL
          ) AS active_members,
          EXISTS (
            SELECT 1 FROM privacy_states privacy
            WHERE privacy.pair_id = pair.id AND privacy.paused = true
          ) AS paused
        FROM auth_sessions session
        JOIN users owner ON owner.id = session.user_id
        CROSS JOIN pairs pair
        WHERE session.id = $1 AND session.user_id = $2 AND pair.id = $3
        FOR SHARE OF session, owner, pair
      `,
      [claims.sessionId, claims.userId, claims.pairId],
    );
    const state = fence.rows[0];
    if (!state || !state.session_valid) {
      await client.query("ROLLBACK");
      return "session_revoked";
    }

    const durable = await client.query<RealtimeRow>(
      `
        SELECT event.id::text, event.event_uuid::text, event.event_type,
               event.payload, event.occurred_at,
               event.authorization_revision::text
        FROM realtime_events event
        JOIN outbox_events outbox ON outbox.event_uuid = event.event_uuid
        WHERE event.event_uuid = ANY($1::uuid[])
          AND event.pair_id = $2
          AND event.suppressed_at IS NULL
          AND outbox.dead_lettered_at IS NULL
          AND (
            event.event_type = ANY($3::text[])
            OR (
              event.delivery_authorized_at IS NOT NULL
              AND event.delivery_authorized_revision = event.authorization_revision
            )
          )
          AND (
            $4::boolean = false
            OR (
              event.delivery_authorized_at IS NOT NULL
              AND event.delivery_authorized_revision = event.authorization_revision
            )
          )
        ORDER BY event.id
      `,
      [eventUuids, claims.pairId, [...controlEventTypes], replay],
    );

    const consents = await client.query<ConsentRow>(
      `
        SELECT grantor_user_id::text, grantee_user_id::text, capability,
               granted, updated_at
        FROM consent_grants
        WHERE pair_id = $1
      `,
      [claims.pairId],
    );
    let denied = false;
    for (const row of durable.rows) {
      const event = toEnvelope(row, claims.pairId);
      if (controlEventTypes.has(event.type)) {
        send(event);
        continue;
      }
      const actorUserId = event.payload.actorUserId;
      const recipientUserId = event.payload.recipientUserId;
      const requirement =
        typeof actorUserId === "string" && typeof recipientUserId === "string"
          ? directionalConsentForEvent({
              type: event.type,
              actorUserId,
              recipientUserId,
            })
          : null;
      const allowed =
        state.pair_status === "active" &&
        state.viewer_active &&
        state.active_members === 2 &&
        !state.paused &&
        row.authorization_revision === state.authorization_revision &&
        requirement !== null &&
        (claims.userId === actorUserId || claims.userId === recipientUserId) &&
        consents.rows.some(
          (grant) =>
            grant.grantor_user_id === requirement.grantorUserId &&
            grant.grantee_user_id === requirement.granteeUserId &&
            grant.capability === requirement.capability &&
            grant.granted &&
            grant.updated_at <= row.occurred_at,
        );
      if (allowed) send(event);
      else denied = true;
    }
    await client.query("COMMIT");
    return denied ? "consent_denied" : "allowed";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function toEnvelope(row: RealtimeRow, pairId: string): RealtimeEventEnvelope {
  return realtimeEventEnvelopeSchema.parse({
    version: 1,
    id: row.event_uuid,
    eventId: row.id,
    authorizationRevision: row.authorization_revision,
    type: row.event_type,
    occurredAt: row.occurred_at.toISOString(),
    pairId,
    payload: row.payload,
  });
}

function compareEventIds(
  left: RealtimeEventEnvelope,
  right: RealtimeEventEnvelope,
): number {
  return BigInt(left.eventId) < BigInt(right.eventId)
    ? -1
    : BigInt(left.eventId) > BigInt(right.eventId)
      ? 1
      : 0;
}

async function waitForSocketCapacity(
  socket: {
    readyState: number;
    bufferedAmount: number;
    close(code: number, reason: string): void;
  },
  maximumBufferedBytes: number,
  onTimeout: () => void,
): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (
    socket.readyState === 1 &&
    socket.bufferedAmount > maximumBufferedBytes
  ) {
    if (Date.now() >= deadline) {
      onTimeout();
      socket.close(1013, "realtime client is too slow");
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return socket.readyState === 1;
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Realtime transient operation timed out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

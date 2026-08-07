import type { FastifyInstance } from "fastify";

import {
  aiMemoryListResponseSchema,
  aiMemoryResponseSchema,
  aiSessionResponseSchema,
  createAiMemorySchema,
} from "@rafay-pair/api-contracts";

import { MEMORY_LIMIT, invokeTool, listTools } from "../ai/tools.js";
import { withTransaction } from "../database.js";
import { ApiError } from "../errors.js";
import { authGuard, mutationGuard } from "../guards.js";
import { authenticated } from "../types.js";

/**
 * The disclosure the client must present before any generated audio plays.
 *
 * It is server-supplied rather than a client string so a client cannot quietly
 * drop or reword it, and so changing it does not require shipping three apps.
 */
const IDENTITY_DISCLOSURE =
  "You are talking to Rafay AI. This is a generated voice, not a person, and not a clinician.";

/** Bounded session duration, per master specification §29 abuse controls. */
const SESSION_TTL_MS = 20 * 60 * 1000;
/** Sessions a user may start per rolling hour. */
const SESSION_QUOTA_PER_HOUR = 12;

interface MemoryRow {
  id: string;
  category: string;
  content: string;
  author: string;
  created_at: Date;
  updated_at: Date;
}

interface SessionRow {
  id: string;
  status: string;
  started_at: Date;
  ended_at: Date | null;
  expires_at: Date;
  identity_announced: boolean;
}

function serializeMemory(row: MemoryRow): Record<string, unknown> {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    author: row.author,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function serializeSession(row: SessionRow): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
    identityAnnounced: row.identity_announced,
    identityDisclosure: IDENTITY_DISCLOSURE,
    allowedTools: listTools(),
  };
}

export async function registerAiRoutes(app: FastifyInstance): Promise<void> {
  const dependencies = app.dependencies;
  const { pool } = dependencies;

  // MARK: - Memory controls

  app.get(
    "/v1/ai/memories",
    { preHandler: authGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const result = await pool.query<MemoryRow>(
        `
          SELECT id::text, category, content, author, created_at, updated_at
          FROM ai_memories WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT $2
        `,
        [auth.userId, MEMORY_LIMIT],
      );
      return reply.code(200).send(
        aiMemoryListResponseSchema.parse({
          memories: result.rows.map(serializeMemory),
          limit: MEMORY_LIMIT,
        }),
      );
    },
  );

  app.post(
    "/v1/ai/memories",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const body = createAiMemorySchema.parse(request.body);

      const memory = await withTransaction(pool, async (client) => {
        const count = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM ai_memories WHERE user_id = $1 FOR UPDATE",
          [auth.userId],
        );
        if ((count.rows[0]?.count ?? 0) >= MEMORY_LIMIT) {
          throw new ApiError(
            409,
            "MEMORY_LIMIT_REACHED",
            "Delete an existing memory before adding another.",
          );
        }
        const inserted = await client.query<MemoryRow>(
          `
            INSERT INTO ai_memories (user_id, category, content, author)
            VALUES ($1, $2, $3, 'user')
            RETURNING id::text, category, content, author, created_at, updated_at
          `,
          [auth.userId, body.category, body.content],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error("Memory insert returned no row");
        return row;
      });

      return reply
        .code(201)
        .send(
          aiMemoryResponseSchema.parse({ memory: serializeMemory(memory) }),
        );
    },
  );

  /** Deletion is real deletion, not a hidden flag. */
  app.delete(
    "/v1/ai/memories/:id",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const { id } = request.params as { id: string };
      const deleted = await pool.query(
        "DELETE FROM ai_memories WHERE id = $1 AND user_id = $2",
        [id, auth.userId],
      );
      if (deleted.rowCount === 0) {
        throw new ApiError(404, "NOT_FOUND", "No such memory.");
      }
      return reply.code(204).send();
    },
  );

  /** Forget everything at once, without deleting the account. */
  app.delete(
    "/v1/ai/memories",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      await pool.query("DELETE FROM ai_memories WHERE user_id = $1", [
        auth.userId,
      ]);
      return reply.code(204).send();
    },
  );

  // MARK: - Session lifecycle

  app.get(
    "/v1/ai/sessions/current",
    { preHandler: authGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const session = await withTransaction(pool, async (client) => {
        await expireStaleSessions(client, auth.userId);
        const result = await client.query<SessionRow>(
          `
            SELECT id::text, status, started_at, ended_at, expires_at, identity_announced
            FROM ai_sessions
            WHERE user_id = $1 AND status = 'active'
            ORDER BY started_at DESC LIMIT 1
          `,
          [auth.userId],
        );
        return result.rows[0] ?? null;
      });
      return reply.code(200).send(
        aiSessionResponseSchema.parse({
          session: session ? serializeSession(session) : null,
        }),
      );
    },
  );

  /**
   * Start a session.
   *
   * A session is refused while privacy is paused. The assistant reads the user's
   * own state, and a pause is a statement that this is not the moment for that.
   */
  app.post(
    "/v1/ai/sessions",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);

      const session = await withTransaction(pool, async (client) => {
        await expireStaleSessions(client, auth.userId);

        const paused = await client.query<{ paused: boolean }>(
          "SELECT bool_or(paused) AS paused FROM privacy_states WHERE user_id = $1",
          [auth.userId],
        );
        if (paused.rows[0]?.paused === true) {
          throw new ApiError(
            403,
            "PRIVACY_PAUSED",
            "Resume sharing before starting a voice session.",
          );
        }

        const open = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM ai_sessions WHERE user_id = $1 AND status = 'active'",
          [auth.userId],
        );
        if ((open.rows[0]?.count ?? 0) > 0) {
          throw new ApiError(
            409,
            "AI_SESSION_OPEN",
            "A voice session is already running.",
          );
        }

        const recent = await client.query<{ count: number }>(
          `
            SELECT count(*)::int AS count FROM ai_sessions
            WHERE user_id = $1 AND started_at > now() - interval '1 hour'
          `,
          [auth.userId],
        );
        if ((recent.rows[0]?.count ?? 0) >= SESSION_QUOTA_PER_HOUR) {
          throw new ApiError(
            429,
            "AI_SESSION_QUOTA",
            "Too many voice sessions in the last hour.",
          );
        }

        const pair = await client.query<{ pair_id: string }>(
          `
            SELECT member.pair_id::text FROM pair_members member
            JOIN pairs ON pairs.id = member.pair_id
            WHERE member.user_id = $1 AND member.left_at IS NULL AND pairs.status = 'active'
            LIMIT 1
          `,
          [auth.userId],
        );

        const inserted = await client.query<SessionRow>(
          `
            INSERT INTO ai_sessions (user_id, pair_id, status, expires_at)
            VALUES ($1, $2, 'active', now() + ($3 || ' milliseconds')::interval)
            RETURNING id::text, status, started_at, ended_at, expires_at, identity_announced
          `,
          [auth.userId, pair.rows[0]?.pair_id ?? null, String(SESSION_TTL_MS)],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error("AI session insert returned no row");
        return row;
      });

      return reply
        .code(201)
        .send(
          aiSessionResponseSchema.parse({ session: serializeSession(session) }),
        );
    },
  );

  /**
   * Record that the generated-voice disclosure was presented.
   *
   * The client calls this after showing the identity line and before playing
   * audio. A session that never announces itself is visible in the table as one
   * with `identity_announced` false, which is what makes the requirement
   * auditable rather than aspirational.
   */
  app.post(
    "/v1/ai/sessions/:id/identity-announced",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const { id } = request.params as { id: string };
      const updated = await pool.query<SessionRow>(
        `
          UPDATE ai_sessions SET identity_announced = true
          WHERE id = $1 AND user_id = $2 AND status = 'active'
          RETURNING id::text, status, started_at, ended_at, expires_at, identity_announced
        `,
        [id, auth.userId],
      );
      const row = updated.rows[0];
      if (!row) throw new ApiError(404, "NOT_FOUND", "No such active session.");
      return reply
        .code(200)
        .send(
          aiSessionResponseSchema.parse({ session: serializeSession(row) }),
        );
    },
  );

  app.post(
    "/v1/ai/sessions/:id/end",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const { id } = request.params as { id: string };
      const updated = await pool.query<SessionRow>(
        `
          UPDATE ai_sessions
          SET status = 'ended', ended_at = now(), end_reason = 'user_ended'
          WHERE id = $1 AND user_id = $2 AND status = 'active'
          RETURNING id::text, status, started_at, ended_at, expires_at, identity_announced
        `,
        [id, auth.userId],
      );
      const row = updated.rows[0];
      if (!row) throw new ApiError(404, "NOT_FOUND", "No such active session.");
      return reply
        .code(200)
        .send(
          aiSessionResponseSchema.parse({ session: serializeSession(row) }),
        );
    },
  );

  /**
   * Dispatch one tool call.
   *
   * This is the only route through which the assistant can affect anything.
   * Every call is recorded with its decision, and the unique constraint on
   * `(session_id, call_id)` is what makes replay impossible rather than
   * unlikely: a provider that repeats a call id after a reconnect gets the
   * original decision back instead of a second execution.
   */
  app.post(
    "/v1/ai/sessions/:id/tool-calls",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const { id } = request.params as { id: string };
      const body = request.body as {
        callId?: unknown;
        name?: unknown;
        arguments?: unknown;
        confirmed?: unknown;
      };
      const callId = typeof body.callId === "string" ? body.callId : "";
      const name = typeof body.name === "string" ? body.name : "";
      if (!callId || !name) {
        throw new ApiError(
          400,
          "INVALID_TOOL_CALL",
          "callId and name are required.",
        );
      }

      const outcome = await withTransaction(pool, async (client) => {
        const session = await client.query<{ id: string }>(
          `
            SELECT id::text FROM ai_sessions
            WHERE id = $1 AND user_id = $2 AND status = 'active' AND expires_at > now()
            FOR UPDATE
          `,
          [id, auth.userId],
        );
        if (!session.rows[0]) {
          throw new ApiError(404, "NOT_FOUND", "No such active session.");
        }

        const prior = await client.query<{
          decision: string;
          detail: string | null;
        }>(
          "SELECT decision, detail FROM ai_tool_invocations WHERE session_id = $1 AND call_id = $2",
          [id, callId],
        );
        const seen = prior.rows[0];
        if (seen) {
          return {
            decision: seen.decision,
            detail: seen.detail,
            replayed: true,
          };
        }

        const result = await invokeTool(
          {
            callId,
            name,
            argumentsJson: body.arguments ?? {},
            confirmed: body.confirmed === true,
          },
          { client, userId: auth.userId, confirmed: body.confirmed === true },
        );

        // A call awaiting confirmation is not settled, so it is not recorded:
        // the user is expected to answer and the same call id to arrive again.
        if (result.decision !== "confirmation_required") {
          await client.query(
            `
              INSERT INTO ai_tool_invocations (
                session_id, user_id, call_id, tool_name, decision, detail
              ) VALUES ($1, $2, $3, $4, $5, $6)
            `,
            [
              id,
              auth.userId,
              callId,
              name,
              result.decision,
              result.detail ?? null,
            ],
          );
        }
        return { ...result, replayed: false };
      });

      return reply.code(200).send(outcome);
    },
  );
}

/** Bounded duration is enforced on read as well as by the worker. */
async function expireStaleSessions(
  client: { query: (text: string, values: unknown[]) => Promise<unknown> },
  userId: string,
): Promise<void> {
  await client.query(
    `
      UPDATE ai_sessions
      SET status = 'expired', ended_at = now(), end_reason = 'expired'
      WHERE user_id = $1 AND status = 'active' AND expires_at <= now()
    `,
    [userId],
  );
}

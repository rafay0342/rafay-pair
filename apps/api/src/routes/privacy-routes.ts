import type { FastifyInstance } from "fastify";

import { SessionCoordinator } from "@rafay-pair/session-coordinator";

import { withTransaction } from "../database.js";
import { appendRealtimeOutboxEvent } from "../events.js";
import { authGuard, mutationGuard } from "../guards.js";
import { authenticated } from "../types.js";

export async function registerPrivacyRoutes(
  app: FastifyInstance,
): Promise<void> {
  const dependencies = app.dependencies;
  const { pool, realtimeBroker } = dependencies;

  app.get(
    "/v1/privacy",
    { preHandler: authGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const pair = await new SessionCoordinator(pool).getActivePair(
        auth.userId,
      );
      const result = await pool.query<{
        paused: boolean;
        paused_at: Date | null;
        updated_at: Date;
      }>(
        `
        SELECT paused, paused_at, updated_at FROM privacy_states
        WHERE pair_id = $1 AND user_id = $2
      `,
        [pair.pairId, auth.userId],
      );
      const row = result.rows[0];
      if (!row)
        throw new Error("Privacy state is missing for active pair member");
      return reply.send({
        privacy: {
          pairId: pair.pairId,
          userId: auth.userId,
          paused: row.paused,
          ...(row.paused_at ? { pausedAt: row.paused_at.toISOString() } : {}),
          updatedAt: row.updated_at.toISOString(),
        },
      });
    },
  );

  for (const [path, paused] of [
    ["/v1/privacy/pause", true],
    ["/v1/privacy/resume", false],
  ] as const) {
    app.post(
      path,
      { preHandler: mutationGuard(dependencies) },
      async (request, reply) => {
        const auth = authenticated(request);
        const result = await withTransaction(pool, async (client) => {
          const pair = await new SessionCoordinator(client).getActivePair(
            auth.userId,
            true,
          );
          const current = await client.query<{
            paused: boolean;
            paused_at: Date | null;
            updated_at: Date;
          }>(
            `
            SELECT paused, paused_at, updated_at FROM privacy_states
            WHERE pair_id = $1 AND user_id = $2 FOR UPDATE
          `,
            [pair.pairId, auth.userId],
          );
          const previous = current.rows[0];
          if (!previous)
            throw new Error("Privacy state is missing for active pair member");
          if (previous.paused === paused) {
            return {
              privacy: {
                pairId: pair.pairId,
                userId: auth.userId,
                paused,
                ...(previous.paused_at
                  ? { pausedAt: previous.paused_at.toISOString() }
                  : {}),
                updatedAt: previous.updated_at.toISOString(),
              },
            };
          }
          const updated = await client.query<{
            paused_at: Date | null;
            updated_at: Date;
          }>(
            `
            UPDATE privacy_states
            SET paused = $3, paused_at = CASE WHEN $3 THEN now() ELSE NULL END, updated_at = now()
            WHERE pair_id = $1 AND user_id = $2
            RETURNING paused_at, updated_at
          `,
            [pair.pairId, auth.userId, paused],
          );
          const row = updated.rows[0];
          if (!row) throw new Error("Privacy state update returned no row");
          await client.query(
            `
            INSERT INTO privacy_audit_log(pair_id, user_id, previous_paused, new_paused)
            VALUES ($1, $2, $3, $4)
          `,
            [pair.pairId, auth.userId, previous.paused, paused],
          );
          const event = await appendRealtimeOutboxEvent(client, {
            type: paused ? "privacy.paused" : "privacy.resumed",
            aggregateType: "privacy",
            aggregateId: pair.pairId,
            pairId: pair.pairId,
            actorUserId: auth.userId,
            recipientUserId: pair.partnerUserId,
            payload: { userId: auth.userId, paused },
          });
          return {
            privacy: {
              pairId: pair.pairId,
              userId: auth.userId,
              paused,
              ...(row.paused_at
                ? { pausedAt: row.paused_at.toISOString() }
                : {}),
              updatedAt: row.updated_at.toISOString(),
            },
            event,
          };
        });
        if (result.event) {
          await realtimeBroker
            .publish(result.event)
            .catch((error: unknown) =>
              request.log.warn({ err: error }, "direct privacy publish failed"),
            );
        }
        return reply.send({ privacy: result.privacy });
      },
    );
  }
}

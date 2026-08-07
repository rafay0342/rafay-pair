import type { FastifyInstance } from "fastify";
import { DatabaseError } from "pg";

import {
  consentCapabilities,
  joinPairRequestSchema,
} from "@rafay-pair/api-contracts";

import { recordSecurityAudit } from "../audit.js";
import { withTransaction } from "../database.js";
import { appendRealtimeOutboxEvent } from "../events.js";
import { ApiError } from "../errors.js";
import { authGuard, mutationGuard } from "../guards.js";
import { getCurrentPair } from "../pairs.js";
import { createJoinCode, tokenHash } from "../security.js";
import { authenticated } from "../types.js";

export async function registerPairRoutes(app: FastifyInstance): Promise<void> {
  const dependencies = app.dependencies;
  const { config, pool, realtimeBroker } = dependencies;

  app.get(
    "/v1/pairs/current",
    { preHandler: authGuard(dependencies) },
    async (request, reply) => {
      const pair = await getCurrentPair(pool, authenticated(request).userId);
      if (!pair) throw new ApiError(404, "PAIR_NOT_FOUND", "Pair not found");
      return reply.send({ pair });
    },
  );

  app.post(
    "/v1/pairs/current",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      let code = "";
      const pair = await withTransaction(pool, async (client) => {
        if (await getCurrentPair(client, auth.userId)) {
          throw new ApiError(
            409,
            "PAIR_ALREADY_EXISTS",
            "A current pair already exists",
          );
        }
        for (let attempt = 0; attempt < 5; attempt += 1) {
          code = createJoinCode();
          try {
            const inserted = await client.query<{ id: string }>(
              `
              INSERT INTO pairs (
                created_by_user_id, status, join_code_hash, join_code_expires_at
              ) VALUES ($1, 'waiting', $2, now() + interval '24 hours')
              RETURNING id
            `,
              [auth.userId, tokenHash(code, config.joinCodePepper)],
            );
            const pairId = inserted.rows[0]?.id;
            if (!pairId) throw new Error("Pair insert returned no id");
            await client.query(
              "INSERT INTO pair_members(pair_id, user_id) VALUES ($1, $2)",
              [pairId, auth.userId],
            );
            await client.query(
              "INSERT INTO privacy_states(pair_id, user_id) VALUES ($1, $2)",
              [pairId, auth.userId],
            );
            await recordSecurityAudit(client, config, {
              actorUserId: auth.userId,
              action: "pair.create",
              targetType: "pair",
              targetId: pairId,
              requestId: request.id,
              ip: request.ip,
            });
            const created = await getCurrentPair(client, auth.userId);
            if (!created) throw new Error("Created pair could not be read");
            return { ...created, joinCode: code };
          } catch (error) {
            if (
              error instanceof DatabaseError &&
              error.code === "23505" &&
              error.constraint?.includes("join_code")
            ) {
              continue;
            }
            throw error;
          }
        }
        throw new Error("Could not allocate unique pair join code");
      });
      return reply.status(201).send({ pair });
    },
  );

  app.post(
    "/v1/pairs/join",
    {
      preHandler: mutationGuard(dependencies),
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const auth = authenticated(request);
      const { code } = joinPairRequestSchema.parse(request.body);
      const pair = await withTransaction(pool, async (client) => {
        if (await getCurrentPair(client, auth.userId)) {
          throw new ApiError(
            409,
            "PAIR_ALREADY_EXISTS",
            "A current pair already exists",
          );
        }
        const pairResult = await client.query<{
          id: string;
          created_by_user_id: string;
        }>(
          `
          SELECT id, created_by_user_id
          FROM pairs
          WHERE join_code_hash = $1
            AND status = 'waiting'
            AND join_code_expires_at > now()
          FOR UPDATE
        `,
          [tokenHash(code, config.joinCodePepper)],
        );
        const waitingPair = pairResult.rows[0];
        if (!waitingPair)
          throw new ApiError(
            404,
            "JOIN_CODE_INVALID",
            "Join code is invalid or expired",
          );
        if (waitingPair.created_by_user_id === auth.userId) {
          throw new ApiError(
            409,
            "CANNOT_JOIN_OWN_PAIR",
            "You cannot join your own pair",
          );
        }
        await client.query(
          "INSERT INTO pair_members(pair_id, user_id) VALUES ($1, $2)",
          [waitingPair.id, auth.userId],
        );
        await client.query(
          "INSERT INTO privacy_states(pair_id, user_id) VALUES ($1, $2)",
          [waitingPair.id, auth.userId],
        );
        await client.query(
          `
          UPDATE pairs
          SET status = 'active', activated_at = now(), join_code_hash = NULL, join_code_expires_at = NULL
          WHERE id = $1
        `,
          [waitingPair.id],
        );

        for (const [grantor, grantee] of [
          [waitingPair.created_by_user_id, auth.userId],
          [auth.userId, waitingPair.created_by_user_id],
        ] as const) {
          for (const capability of consentCapabilities) {
            await client.query(
              `
              INSERT INTO consent_grants (
                pair_id, grantor_user_id, grantee_user_id, capability, granted
              ) VALUES ($1, $2, $3, $4, false)
            `,
              [waitingPair.id, grantor, grantee, capability],
            );
            await client.query(
              `
              INSERT INTO consent_audit_log (
                pair_id, grantor_user_id, grantee_user_id, capability,
                previous_granted, new_granted, actor_user_id, reason
              ) VALUES ($1, $2, $3, $4, NULL, false, $2, 'pair_join_default_deny')
            `,
              [waitingPair.id, grantor, grantee, capability],
            );
          }
        }
        await recordSecurityAudit(client, config, {
          actorUserId: auth.userId,
          action: "pair.join",
          targetType: "pair",
          targetId: waitingPair.id,
          requestId: request.id,
          ip: request.ip,
        });
        const active = await getCurrentPair(client, auth.userId);
        if (!active) throw new Error("Joined pair could not be read");
        return active;
      });
      return reply.send({ pair });
    },
  );

  app.delete(
    "/v1/pairs/current",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const result = await withTransaction(pool, async (client) => {
        const current = await getCurrentPair(client, auth.userId);
        if (!current)
          throw new ApiError(404, "PAIR_NOT_FOUND", "Pair not found");
        await client.query("SELECT id FROM pairs WHERE id = $1 FOR UPDATE", [
          current.id,
        ]);
        await client.query(
          `
          INSERT INTO consent_audit_log (
            pair_id, grantor_user_id, grantee_user_id, capability,
            previous_granted, new_granted, actor_user_id, reason
          )
          SELECT pair_id, grantor_user_id, grantee_user_id, capability,
                 granted, false, $2, 'pair_disconnected'
          FROM consent_grants
          WHERE pair_id = $1 AND granted = true
        `,
          [current.id, auth.userId],
        );
        await client.query(
          "UPDATE consent_grants SET granted = false, updated_at = now() WHERE pair_id = $1",
          [current.id],
        );
        await client.query(
          "UPDATE pair_members SET left_at = now() WHERE pair_id = $1 AND left_at IS NULL",
          [current.id],
        );
        await client.query(
          `
          UPDATE pairs
          SET status = 'disconnected', disconnected_at = now(), disconnected_by_user_id = $2,
              join_code_hash = NULL, join_code_expires_at = NULL
          WHERE id = $1
        `,
          [current.id, auth.userId],
        );
        const event = await appendRealtimeOutboxEvent(client, {
          type: "pair.disconnected",
          aggregateType: "pair",
          aggregateId: current.id,
          pairId: current.id,
          actorUserId: auth.userId,
          payload: { disconnectedByUserId: auth.userId },
        });
        await recordSecurityAudit(client, config, {
          actorUserId: auth.userId,
          action: "pair.disconnect",
          targetType: "pair",
          targetId: current.id,
          requestId: request.id,
          ip: request.ip,
        });
        return event;
      });
      await realtimeBroker
        .publish(result)
        .catch((error: unknown) =>
          request.log.warn({ err: error }, "direct realtime publish failed"),
        );
      return reply.status(204).send();
    },
  );
}

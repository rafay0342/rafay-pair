import type { PoolClient } from "pg";
import type { FastifyInstance } from "fastify";

import {
  createTogetherSessionSchema,
  publishTogetherStateSchema,
  respondTogetherSessionSchema,
  togetherSessionResponseSchema,
} from "@rafay-pair/api-contracts";
import { SessionCoordinator } from "@rafay-pair/session-coordinator";

import { withTransaction } from "../database.js";
import { ApiError } from "../errors.js";
import { appendRealtimeOutboxEvent } from "../events.js";
import { authGuard, mutationGuard } from "../guards.js";
import { authenticated } from "../types.js";

/**
 * An unanswered invitation must not sit open indefinitely offering a live
 * channel, so it expires the way a care request does.
 */
const INVITE_TTL_MS = 10 * 60 * 1000;

interface SessionRow {
  id: string;
  pair_id: string;
  invited_by_user_id: string;
  invited_user_id: string;
  activity: string;
  status: string;
  created_at: Date;
  accepted_at: Date | null;
  ended_at: Date | null;
  expires_at: Date;
}

interface StateRow {
  user_id: string;
  repetitions: number;
  exercise_phase: string;
  set_index: number;
  elapsed_ms: number;
  estimated_kcal: string | null;
  breathing_state: string | null;
  updated_at: Date;
}

function serialize(
  session: SessionRow,
  states: readonly StateRow[],
): Record<string, unknown> {
  return {
    id: session.id,
    pairId: session.pair_id,
    invitedByUserId: session.invited_by_user_id,
    invitedUserId: session.invited_user_id,
    activity: session.activity,
    status: session.status,
    createdAt: session.created_at.toISOString(),
    acceptedAt: session.accepted_at?.toISOString() ?? null,
    endedAt: session.ended_at?.toISOString() ?? null,
    expiresAt: session.expires_at.toISOString(),
    participants: states.map((state) => ({
      userId: state.user_id,
      repetitions: state.repetitions,
      exercisePhase: state.exercise_phase,
      setIndex: state.set_index,
      elapsedMs: state.elapsed_ms,
      estimatedKcal:
        state.estimated_kcal === null ? null : Number(state.estimated_kcal),
      breathingState: state.breathing_state,
      updatedAt: state.updated_at.toISOString(),
    })),
  };
}

/**
 * Expires stale invitations on read, so a session that was never answered stops
 * being live without needing a sweeper to have run first.
 */
async function expireStaleInvites(
  client: PoolClient,
  pairId: string,
): Promise<void> {
  await client.query(
    `
      UPDATE together_sessions
      SET status = 'expired', ended_at = now()
      WHERE pair_id = $1 AND status = 'invited' AND expires_at <= now()
    `,
    [pairId],
  );
}

async function openSession(
  client: PoolClient,
  pairId: string,
): Promise<SessionRow | undefined> {
  const result = await client.query<SessionRow>(
    `
      SELECT * FROM together_sessions
      WHERE pair_id = $1 AND status IN ('invited', 'active')
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
    `,
    [pairId],
  );
  return result.rows[0];
}

/**
 * Reads participant states, dropping the partner's if their grant has since been
 * revoked.
 *
 * A stored state is evidence that consent existed when it was published, not a
 * standing permission to keep showing it. Filtering on read is what makes
 * revocation take effect immediately for data already at rest.
 */
async function visibleStates(
  client: PoolClient,
  sessionId: string,
  viewerUserId: string,
  pairId: string,
  partnerUserId: string,
): Promise<StateRow[]> {
  const states = await client.query<StateRow>(
    "SELECT * FROM together_participant_states WHERE session_id = $1",
    [sessionId],
  );
  const grant = await client.query<{ granted: boolean }>(
    `
      SELECT granted FROM consent_grants
      WHERE pair_id = $1 AND grantor_user_id = $2 AND grantee_user_id = $3
        AND capability = 'workout_progress'
    `,
    [pairId, partnerUserId, viewerUserId],
  );
  const maySeePartner = grant.rows[0]?.granted === true;
  return states.rows.filter(
    (state) => state.user_id === viewerUserId || maySeePartner,
  );
}

export async function registerTogetherRoutes(
  app: FastifyInstance,
): Promise<void> {
  const dependencies = app.dependencies;
  const { pool } = dependencies;

  /** The current session for this pair, if one is open. */
  app.get(
    "/v1/together-sessions/current",
    { preHandler: authGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const payload = await withTransaction(pool, async (client) => {
        const pair = await new SessionCoordinator(client).getActivePair(
          auth.userId,
          true,
        );
        await expireStaleInvites(client, pair.pairId);
        const session = await openSession(client, pair.pairId);
        if (!session) return null;
        const states = await visibleStates(
          client,
          session.id,
          auth.userId,
          pair.pairId,
          pair.partnerUserId,
        );
        return serialize(session, states);
      });

      return reply
        .code(200)
        .send(togetherSessionResponseSchema.parse({ session: payload }));
    },
  );

  /**
   * Invite the partner into a shared workout.
   *
   * Inviting requires the inviter's own sharing grant: proposing a session whose
   * whole point is mutual visibility, while withholding your own state, is not a
   * coherent request.
   */
  app.post(
    "/v1/together-sessions",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const body = createTogetherSessionSchema.parse(request.body);

      const payload = await withTransaction(pool, async (client) => {
        const pair = await new SessionCoordinator(client).authorizeSharing(
          auth.userId,
          "workout_progress",
        );
        await expireStaleInvites(client, pair.pairId);
        const existing = await openSession(client, pair.pairId);
        if (existing) {
          throw new ApiError(
            409,
            "TOGETHER_SESSION_OPEN",
            "A together session is already open for this pair.",
          );
        }

        const inserted = await client.query<SessionRow>(
          `
            INSERT INTO together_sessions (
              pair_id, invited_by_user_id, invited_user_id, activity, status, expires_at
            )
            VALUES ($1, $2, $3, $4, 'invited', now() + ($5 || ' milliseconds')::interval)
            RETURNING *
          `,
          [
            pair.pairId,
            auth.userId,
            pair.partnerUserId,
            body.activity,
            String(INVITE_TTL_MS),
          ],
        );
        const session = inserted.rows[0];
        if (!session)
          throw new Error("Together session insert returned no row");

        await appendRealtimeOutboxEvent(client, {
          type: "together.session.invited",
          aggregateType: "together",
          aggregateId: session.id,
          pairId: pair.pairId,
          actorUserId: auth.userId,
          recipientUserId: pair.partnerUserId,
          payload: { sessionId: session.id, activity: session.activity },
        });
        return serialize(session, []);
      });

      return reply
        .code(201)
        .send(togetherSessionResponseSchema.parse({ session: payload }));
    },
  );

  /** Accept or decline an invitation. Only the invited member may answer. */
  app.post(
    "/v1/together-sessions/:id/respond",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const body = respondTogetherSessionSchema.parse(request.body);
      const { id } = request.params as { id: string };

      const payload = await withTransaction(pool, async (client) => {
        // Accepting also requires the accepter's own sharing grant, for the same
        // reason inviting does.
        const pair =
          body.response === "accepted"
            ? await new SessionCoordinator(client).authorizeSharing(
                auth.userId,
                "workout_progress",
              )
            : await new SessionCoordinator(client).getActivePair(
                auth.userId,
                true,
              );

        const found = await client.query<SessionRow>(
          `
            SELECT * FROM together_sessions
            WHERE id = $1 AND pair_id = $2
            FOR UPDATE
          `,
          [id, pair.pairId],
        );
        const session = found.rows[0];
        if (!session) {
          throw new ApiError(404, "NOT_FOUND", "No such together session.");
        }
        if (session.invited_user_id !== auth.userId) {
          throw new ApiError(
            403,
            "NOT_INVITED",
            "Only the invited partner may answer this session.",
          );
        }
        if (session.status !== "invited") {
          throw new ApiError(
            409,
            "TOGETHER_SESSION_SETTLED",
            "This session has already been answered.",
          );
        }
        if (session.expires_at.getTime() <= Date.now()) {
          await client.query(
            "UPDATE together_sessions SET status = 'expired', ended_at = now() WHERE id = $1",
            [id],
          );
          throw new ApiError(
            409,
            "TOGETHER_SESSION_EXPIRED",
            "This invitation expired before it was answered.",
          );
        }

        const accepted = body.response === "accepted";
        const updated = await client.query<SessionRow>(
          `
            UPDATE together_sessions
            SET status = $2,
                accepted_at = CASE WHEN $2 = 'active' THEN now() ELSE accepted_at END,
                ended_at = CASE WHEN $2 = 'declined' THEN now() ELSE ended_at END,
                ended_by_user_id = CASE WHEN $2 = 'declined' THEN $3 ELSE ended_by_user_id END
            WHERE id = $1
            RETURNING *
          `,
          [id, accepted ? "active" : "declined", auth.userId],
        );
        const row = updated.rows[0];
        if (!row) throw new Error("Together session update returned no row");

        await appendRealtimeOutboxEvent(client, {
          type: accepted
            ? "together.session.accepted"
            : "together.session.declined",
          aggregateType: "together",
          aggregateId: row.id,
          pairId: pair.pairId,
          actorUserId: auth.userId,
          recipientUserId: pair.partnerUserId,
          payload: { sessionId: row.id, activity: row.activity },
        });
        return serialize(row, []);
      });

      return reply
        .code(200)
        .send(togetherSessionResponseSchema.parse({ session: payload }));
    },
  );

  /**
   * Publish derived state.
   *
   * Only the six derived values the specification lists are accepted; there is
   * no field for a frame, a landmark, or an audio sample.
   */
  app.put(
    "/v1/together-sessions/:id/state",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const body = publishTogetherStateSchema.parse(request.body);
      const { id } = request.params as { id: string };

      const payload = await withTransaction(pool, async (client) => {
        const pair = await new SessionCoordinator(client).authorizeSharing(
          auth.userId,
          "workout_progress",
        );
        const found = await client.query<SessionRow>(
          "SELECT * FROM together_sessions WHERE id = $1 AND pair_id = $2 FOR UPDATE",
          [id, pair.pairId],
        );
        const session = found.rows[0];
        if (!session) {
          throw new ApiError(404, "NOT_FOUND", "No such together session.");
        }
        if (session.status !== "active") {
          throw new ApiError(
            409,
            "TOGETHER_SESSION_NOT_ACTIVE",
            "State may only be published to an active session.",
          );
        }

        await client.query(
          `
            INSERT INTO together_participant_states (
              session_id, user_id, repetitions, exercise_phase, set_index,
              elapsed_ms, estimated_kcal, breathing_state, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
            ON CONFLICT (session_id, user_id) DO UPDATE SET
              repetitions = EXCLUDED.repetitions,
              exercise_phase = EXCLUDED.exercise_phase,
              set_index = EXCLUDED.set_index,
              elapsed_ms = EXCLUDED.elapsed_ms,
              estimated_kcal = EXCLUDED.estimated_kcal,
              breathing_state = EXCLUDED.breathing_state,
              updated_at = now()
          `,
          [
            id,
            auth.userId,
            body.repetitions,
            body.exercisePhase,
            body.setIndex,
            body.elapsedMs,
            body.estimatedKcal ?? null,
            body.breathingState ?? null,
          ],
        );

        await appendRealtimeOutboxEvent(client, {
          type: "together.state.updated",
          aggregateType: "together",
          aggregateId: id,
          pairId: pair.pairId,
          actorUserId: auth.userId,
          recipientUserId: pair.partnerUserId,
          payload: {
            sessionId: id,
            repetitions: body.repetitions,
            exercisePhase: body.exercisePhase,
            setIndex: body.setIndex,
            elapsedMs: body.elapsedMs,
            estimatedKcal: body.estimatedKcal ?? null,
            breathingState: body.breathingState ?? null,
          },
        });

        const states = await visibleStates(
          client,
          id,
          auth.userId,
          pair.pairId,
          pair.partnerUserId,
        );
        return serialize(session, states);
      });

      return reply
        .code(200)
        .send(togetherSessionResponseSchema.parse({ session: payload }));
    },
  );

  /**
   * End the session. Either member may end it at any time, and ending needs no
   * consent grant: a control that could be blocked is not a control.
   */
  app.post(
    "/v1/together-sessions/:id/end",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const { id } = request.params as { id: string };

      const payload = await withTransaction(pool, async (client) => {
        const pair = await new SessionCoordinator(client).getActivePair(
          auth.userId,
          true,
        );
        const updated = await client.query<SessionRow>(
          `
            UPDATE together_sessions
            SET status = 'ended', ended_at = now(), ended_by_user_id = $3
            WHERE id = $1 AND pair_id = $2 AND status IN ('invited', 'active')
            RETURNING *
          `,
          [id, pair.pairId, auth.userId],
        );
        const session = updated.rows[0];
        if (!session) {
          throw new ApiError(
            404,
            "NOT_FOUND",
            "No open together session with that identifier.",
          );
        }
        // Derived state is discarded with the session. Keeping a partner's rep
        // history after the session is over serves nothing and would have to be
        // protected forever.
        await client.query(
          "DELETE FROM together_participant_states WHERE session_id = $1",
          [id],
        );

        await appendRealtimeOutboxEvent(client, {
          type: "together.session.ended",
          aggregateType: "together",
          aggregateId: session.id,
          pairId: pair.pairId,
          actorUserId: auth.userId,
          recipientUserId: pair.partnerUserId,
          payload: { sessionId: session.id },
        });
        return serialize(session, []);
      });

      return reply
        .code(200)
        .send(togetherSessionResponseSchema.parse({ session: payload }));
    },
  );
}

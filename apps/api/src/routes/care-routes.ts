import type { FastifyInstance } from "fastify";

import {
  careRequestListQuerySchema,
  createCareRequestSchema,
  respondCareRequestSchema,
} from "@rafay-pair/api-contracts";
import {
  SessionAuthorizationError,
  SessionCoordinator,
} from "@rafay-pair/session-coordinator";

import { type CareRequestRow, serializeCareRequest } from "../care.js";
import { withTransaction } from "../database.js";
import { appendRealtimeOutboxEvent } from "../events.js";
import { ApiError } from "../errors.js";
import { authGuard, mutationGuard } from "../guards.js";
import { authenticated } from "../types.js";

export async function registerCareRoutes(app: FastifyInstance): Promise<void> {
  const dependencies = app.dependencies;
  const { pool } = dependencies;

  app.post(
    "/v1/care-requests",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const body = createCareRequestSchema.parse(request.body);
      const result = await withTransaction(pool, async (client) => {
        const pair = await new SessionCoordinator(
          client,
        ).authorizePartnerAction(auth.userId, "care_requests");
        const inserted = await client.query<CareRequestRow>(
          `
            INSERT INTO care_requests (
              client_request_id, pair_id, sender_user_id, recipient_user_id, kind, message
            ) VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (sender_user_id, client_request_id) DO NOTHING
            RETURNING *
          `,
          [
            body.clientRequestId,
            pair.pairId,
            auth.userId,
            pair.partnerUserId,
            body.kind,
            body.message ?? null,
          ],
        );
        const insertedRow = inserted.rows[0];
        if (!insertedRow) {
          const priorResult = await client.query<CareRequestRow>(
            `
              SELECT * FROM care_requests
              WHERE sender_user_id = $1 AND client_request_id = $2
              FOR UPDATE
            `,
            [auth.userId, body.clientRequestId],
          );
          const prior = priorResult.rows[0];
          if (!prior)
            throw new Error("Conflicting care request was not visible");
          if (
            prior.kind !== body.kind ||
            (prior.message ?? undefined) !== body.message ||
            prior.pair_id !== pair.pairId
          ) {
            throw new ApiError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "Idempotency key conflict",
              "clientRequestId was already used with a different request.",
            );
          }
          return { careRequest: serializeCareRequest(prior) };
        }
        const row = insertedRow;
        const careRequest = serializeCareRequest(row);
        const event = await appendRealtimeOutboxEvent(client, {
          type: "care.request.created",
          aggregateType: "care_request",
          aggregateId: row.id,
          pairId: pair.pairId,
          actorUserId: auth.userId,
          recipientUserId: pair.partnerUserId,
          payload: { careRequest },
        });
        return { careRequest, event };
      });
      return reply.status(201).send({ careRequest: result.careRequest });
    },
  );

  app.get(
    "/v1/care-requests",
    { preHandler: authGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const query = careRequestListQuerySchema.parse(request.query);
      const pair = await new SessionCoordinator(pool).getActivePair(
        auth.userId,
      );
      if (pair.actorPaused || pair.partnerPaused)
        throw new SessionAuthorizationError("PRIVACY_PAUSED");
      const cursor = decodeCareRequestCursor(query.cursor);
      await pool.query(
        `
          UPDATE care_requests
          SET status = 'expired'
          WHERE pair_id = $1 AND status = 'pending' AND expires_at <= now()
        `,
        [pair.pairId],
      );
      const result = await pool.query<CareRequestRow>(
        `
        SELECT * FROM care_requests
        WHERE pair_id = $1
          AND (sender_user_id = $2 OR recipient_user_id = $2)
          AND (
            $3::timestamptz IS NULL
            OR (created_at, id) < ($3::timestamptz, $4::uuid)
          )
        ORDER BY created_at DESC, id DESC
        LIMIT $5
      `,
        [
          pair.pairId,
          auth.userId,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          query.limit + 1,
        ],
      );
      const hasMore = result.rows.length > query.limit;
      const visible = hasMore ? result.rows.slice(0, query.limit) : result.rows;
      const last = visible.at(-1);
      return reply.send({
        items: visible.map(serializeCareRequest),
        ...(hasMore && last
          ? { nextCursor: encodeCareRequestCursor(last) }
          : {}),
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/care-requests/:id/respond",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const body = respondCareRequestSchema.parse(request.body);
      const careRequestId = request.params.id;
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          careRequestId,
        )
      ) {
        throw new ApiError(
          400,
          "VALIDATION_FAILED",
          "Request validation failed",
          "id must be a UUID.",
        );
      }
      const result = await withTransaction(pool, async (client) => {
        const pair = await new SessionCoordinator(client).getActivePair(
          auth.userId,
          true,
        );
        if (pair.actorPaused || pair.partnerPaused)
          throw new SessionAuthorizationError("PRIVACY_PAUSED");
        const existing = await client.query<
          CareRequestRow & { expires_at: Date }
        >(
          `
            SELECT * FROM care_requests
            WHERE id = $1 AND pair_id = $2 AND recipient_user_id = $3
            FOR UPDATE
          `,
          [careRequestId, pair.pairId, auth.userId],
        );
        const row = existing.rows[0];
        if (!row)
          throw new ApiError(
            404,
            "CARE_REQUEST_NOT_FOUND",
            "Care request not found",
          );
        if (row.status === body.response)
          return { careRequest: serializeCareRequest(row) };
        if (row.status !== "pending") {
          throw new ApiError(
            409,
            "CARE_REQUEST_ALREADY_RESOLVED",
            "Care request is already resolved",
          );
        }
        if (row.expires_at <= new Date()) {
          await client.query(
            "UPDATE care_requests SET status = 'expired' WHERE id = $1",
            [row.id],
          );
          return { expired: true as const };
        }
        const updated = await client.query<CareRequestRow>(
          `
            UPDATE care_requests SET status = $2, responded_at = now()
            WHERE id = $1 RETURNING *
          `,
          [row.id, body.response],
        );
        const updatedRow = updated.rows[0];
        if (!updatedRow) throw new Error("Care request update returned no row");
        const careRequest = serializeCareRequest(updatedRow);
        const event = await appendRealtimeOutboxEvent(client, {
          type: "care.request.responded",
          aggregateType: "care_request",
          aggregateId: row.id,
          pairId: pair.pairId,
          actorUserId: auth.userId,
          recipientUserId: pair.partnerUserId,
          payload: { careRequest },
        });
        return { expired: false as const, careRequest, event };
      });
      if (result.expired)
        throw new ApiError(
          409,
          "CARE_REQUEST_EXPIRED",
          "Care request has expired",
        );
      return reply.send({ careRequest: result.careRequest });
    },
  );
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function encodeCareRequestCursor(row: CareRequestRow): string {
  return Buffer.from(
    `${row.created_at.toISOString()}|${row.id}`,
    "utf8",
  ).toString("base64url");
}

function decodeCareRequestCursor(
  raw: string | undefined,
): { createdAt: Date; id: string } | undefined {
  if (!raw) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw invalidCursor();
  }
  const separator = decoded.lastIndexOf("|");
  const createdAtRaw = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  const createdAt = new Date(createdAtRaw);
  if (
    separator <= 0 ||
    !uuidPattern.test(id) ||
    !Number.isFinite(createdAt.getTime()) ||
    createdAt.toISOString() !== createdAtRaw ||
    Buffer.from(decoded, "utf8").toString("base64url") !== raw
  ) {
    throw invalidCursor();
  }
  return { createdAt, id };
}

function invalidCursor(): ApiError {
  return new ApiError(
    400,
    "VALIDATION_FAILED",
    "Request validation failed",
    "cursor is invalid or expired.",
  );
}

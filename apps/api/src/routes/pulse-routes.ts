import type { FastifyInstance } from "fastify";

import {
  partnerPulseSnapshotResponseSchema,
  pulseSnapshotResponseSchema,
  sharePulseSnapshotSchema,
} from "@rafay-pair/api-contracts";
import { SessionCoordinator } from "@rafay-pair/session-coordinator";

import { withTransaction } from "../database.js";
import { ApiError } from "../errors.js";
import { appendRealtimeOutboxEvent } from "../events.js";
import { authGuard, mutationGuard } from "../guards.js";
import { authenticated } from "../types.js";

/**
 * Five minutes, matching `PULSE_FRESHNESS_MS` in the engines.
 *
 * Freshness is computed here rather than left to each client so that both
 * members of a pair agree on whether a reading may still be presented as
 * current. A stale value is stale everywhere.
 */
const FRESHNESS_MS = 300_000;

interface PulseSnapshotRow {
  owner_user_id: string;
  bpm: string;
  confidence_band: string;
  quality_band: string;
  source: string;
  kind: string;
  measured_at: Date;
  shared_at: Date;
}

function serialize(row: PulseSnapshotRow, nowMs: number): unknown {
  const ageMs = Math.max(0, nowMs - row.measured_at.getTime());
  return {
    ownerUserId: row.owner_user_id,
    bpm: Number(row.bpm),
    confidenceBand: row.confidence_band,
    qualityBand: row.quality_band,
    source: row.source,
    kind: row.kind,
    measuredAt: row.measured_at.toISOString(),
    sharedAt: row.shared_at.toISOString(),
    fresh: ageMs < FRESHNESS_MS,
    ageMs,
  };
}

export async function registerPulseRoutes(app: FastifyInstance): Promise<void> {
  const dependencies = app.dependencies;
  const { pool } = dependencies;

  /**
   * Share the latest reading with the partner.
   *
   * Only the derived summary is accepted: there is no field for the sample
   * series, so there is no way for one to arrive. A reading that is already
   * stale is refused rather than shared, because sharing it would present an
   * expired value as news.
   */
  app.post(
    "/v1/pulse-snapshots",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const body = sharePulseSnapshotSchema.parse(request.body);
      const measuredAt = new Date(body.measuredAt);
      const nowMs = Date.now();

      if (Number.isNaN(measuredAt.getTime())) {
        throw new ApiError(
          400,
          "INVALID_MEASURED_AT",
          "measuredAt is not a valid time.",
        );
      }
      if (measuredAt.getTime() > nowMs + 60_000) {
        // A reading from the future indicates a wrong device clock, not a
        // measurement. Accepting it would make it look permanently fresh.
        throw new ApiError(
          400,
          "MEASURED_AT_IN_FUTURE",
          "measuredAt is in the future; check the device clock.",
        );
      }
      if (nowMs - measuredAt.getTime() >= FRESHNESS_MS) {
        throw new ApiError(
          409,
          "PULSE_STALE",
          "This reading has expired. Measure again before sharing.",
        );
      }

      const result = await withTransaction(pool, async (client) => {
        const pair = await new SessionCoordinator(client).authorizeSharing(
          auth.userId,
          "pulse_snapshots",
        );
        const upserted = await client.query<PulseSnapshotRow>(
          `
            INSERT INTO pulse_snapshots (
              pair_id, owner_user_id, bpm, confidence_band, quality_band,
              source, kind, measured_at
            )
            VALUES ($1, $2, $3, $4, $5, 'phone_camera_ppg', 'app_estimated', $6)
            ON CONFLICT (pair_id, owner_user_id) DO UPDATE SET
              bpm = EXCLUDED.bpm,
              confidence_band = EXCLUDED.confidence_band,
              quality_band = EXCLUDED.quality_band,
              measured_at = EXCLUDED.measured_at,
              shared_at = now()
            RETURNING *
          `,
          [
            pair.pairId,
            auth.userId,
            body.bpm,
            body.confidenceBand,
            body.qualityBand,
            measuredAt.toISOString(),
          ],
        );
        const row = upserted.rows[0];
        if (!row) throw new Error("Pulse snapshot upsert returned no row");

        await appendRealtimeOutboxEvent(client, {
          type: "pulse.snapshot.shared",
          aggregateType: "pulse",
          aggregateId: pair.pairId,
          pairId: pair.pairId,
          actorUserId: auth.userId,
          recipientUserId: pair.partnerUserId,
          payload: {
            bpm: Number(row.bpm),
            confidenceBand: row.confidence_band,
            qualityBand: row.quality_band,
            source: row.source,
            kind: row.kind,
            measuredAt: row.measured_at.toISOString(),
          },
        });
        return row;
      });

      return reply.code(200).send(
        pulseSnapshotResponseSchema.parse({
          snapshot: serialize(result, Date.now()),
        }),
      );
    },
  );

  /**
   * Read the partner's latest shared reading.
   *
   * Authorization is directional: the partner is the grantor, so revoking the
   * grant blocks this immediately even though the row still exists.
   */
  app.get(
    "/v1/pulse-snapshots/partner",
    { preHandler: authGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const snapshot = await withTransaction(pool, async (client) => {
        const pair = await new SessionCoordinator(
          client,
        ).authorizePartnerAction(auth.userId, "pulse_snapshots");
        const result = await client.query<PulseSnapshotRow>(
          `
            SELECT * FROM pulse_snapshots
            WHERE pair_id = $1 AND owner_user_id = $2
          `,
          [pair.pairId, pair.partnerUserId],
        );
        return result.rows[0] ?? null;
      });

      return reply.code(200).send(
        partnerPulseSnapshotResponseSchema.parse({
          snapshot: snapshot ? serialize(snapshot, Date.now()) : null,
        }),
      );
    },
  );

  /** Withdraw a previously shared reading without changing the consent grant. */
  app.delete(
    "/v1/pulse-snapshots",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      await withTransaction(pool, async (client) => {
        const pair = await new SessionCoordinator(client).getActivePair(
          auth.userId,
          true,
        );
        await client.query(
          "DELETE FROM pulse_snapshots WHERE pair_id = $1 AND owner_user_id = $2",
          [pair.pairId, auth.userId],
        );
      });
      return reply.code(204).send();
    },
  );
}

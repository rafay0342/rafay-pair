import type { FastifyInstance } from "fastify";

import {
  bloodPressureListResponseSchema,
  bloodPressureResponseSchema,
  importBloodPressureSchema,
  recordManualBloodPressureSchema,
} from "@rafay-pair/api-contracts";

import { withTransaction } from "../database.js";
import { ApiError } from "../errors.js";
import { authGuard, mutationGuard } from "../guards.js";
import { authenticated } from "../types.js";

/**
 * Blood pressure the user brings.
 *
 * Master specification §5 permits exactly two sources — a reading typed from a
 * real cuff, and a record imported from the phone's health repository with its
 * origin preserved. Nothing here computes, predicts, or infers a value, and
 * there is no route through which a derived one could enter: the two handlers
 * below pin `measurement_kind` to the route rather than reading it from the
 * request, so a client cannot describe a typed reading as externally sourced.
 *
 * These readings are personal and are never shared with a partner. There is no
 * consent capability for blood pressure, no partner route, and no realtime
 * event, which is why this file never touches the session coordinator.
 */

/** A ceiling per user, so a runaway import cannot fill the table. */
const READING_LIMIT = 200;

interface ReadingRow {
  id: string;
  systolic: number;
  diastolic: number;
  pulse_bpm: number | null;
  source: string;
  measurement_kind: string;
  external_origin: string | null;
  measured_at: Date;
  note: string | null;
  created_at: Date;
}

function serialize(row: ReadingRow): Record<string, unknown> {
  return {
    id: row.id,
    systolic: row.systolic,
    diastolic: row.diastolic,
    pulseBpm: row.pulse_bpm,
    source: row.source,
    measurementKind: row.measurement_kind,
    externalOrigin: row.external_origin,
    measuredAt: row.measured_at.toISOString(),
    note: row.note,
    createdAt: row.created_at.toISOString(),
  };
}

const RETURNING = `
  id::text, systolic, diastolic, pulse_bpm, source, measurement_kind,
  external_origin, measured_at, note, created_at
`;

export async function registerBloodPressureRoutes(
  app: FastifyInstance,
): Promise<void> {
  const dependencies = app.dependencies;
  const { pool } = dependencies;

  async function assertRoom(
    client: Parameters<Parameters<typeof withTransaction>[1]>[0],
    userId: string,
  ): Promise<void> {
    const count = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM blood_pressure_readings WHERE user_id = $1",
      [userId],
    );
    if ((count.rows[0]?.count ?? 0) >= READING_LIMIT) {
      throw new ApiError(
        409,
        "BLOOD_PRESSURE_LIMIT",
        `Delete an older reading first; ${String(READING_LIMIT)} are kept.`,
      );
    }
  }

  app.get(
    "/v1/blood-pressure",
    { preHandler: authGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const result = await pool.query<ReadingRow>(
        `
          SELECT ${RETURNING} FROM blood_pressure_readings
          WHERE user_id = $1 ORDER BY measured_at DESC LIMIT $2
        `,
        [auth.userId, READING_LIMIT],
      );
      return reply.code(200).send(
        bloodPressureListResponseSchema.parse({
          readings: result.rows.map(serialize),
          limit: READING_LIMIT,
        }),
      );
    },
  );

  /** A reading the user typed, from a cuff they used. */
  app.post(
    "/v1/blood-pressure",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const body = recordManualBloodPressureSchema.parse(request.body);
      const measuredAt = new Date(body.measuredAt);
      if (measuredAt.getTime() > Date.now() + 60_000) {
        throw new ApiError(
          400,
          "MEASURED_IN_FUTURE",
          "A reading cannot have been taken in the future.",
        );
      }

      const row = await withTransaction(pool, async (client) => {
        await assertRoom(client, auth.userId);
        const inserted = await client.query<ReadingRow>(
          `
            INSERT INTO blood_pressure_readings (
              user_id, systolic, diastolic, pulse_bpm,
              source, measurement_kind, measured_at, note
            ) VALUES ($1, $2, $3, $4, 'manual_entry', 'manually_entered', $5, $6)
            RETURNING ${RETURNING}
          `,
          [
            auth.userId,
            body.systolic,
            body.diastolic,
            body.pulseBpm ?? null,
            measuredAt.toISOString(),
            body.note ?? null,
          ],
        );
        const created = inserted.rows[0];
        if (!created) throw new Error("Blood pressure insert returned no row");
        return created;
      });

      return reply
        .code(201)
        .send(bloodPressureResponseSchema.parse({ reading: serialize(row) }));
    },
  );

  /**
   * A record imported from the phone's health repository.
   *
   * Importing the same record twice returns the reading that already exists
   * rather than creating a second one — a repeated sync is the normal case, not
   * an error, and duplicated readings would misrepresent how often someone
   * measured.
   */
  app.post(
    "/v1/blood-pressure/imports",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const body = importBloodPressureSchema.parse(request.body);
      const measuredAt = new Date(body.measuredAt);
      if (measuredAt.getTime() > Date.now() + 60_000) {
        throw new ApiError(
          400,
          "MEASURED_IN_FUTURE",
          "A reading cannot have been taken in the future.",
        );
      }

      const outcome = await withTransaction(pool, async (client) => {
        const existing = await client.query<ReadingRow>(
          `
            SELECT ${RETURNING} FROM blood_pressure_readings
            WHERE user_id = $1 AND external_record_id = $2
          `,
          [auth.userId, body.externalRecordId],
        );
        const seen = existing.rows[0];
        if (seen) return { row: seen, created: false };

        await assertRoom(client, auth.userId);
        const inserted = await client.query<ReadingRow>(
          `
            INSERT INTO blood_pressure_readings (
              user_id, systolic, diastolic, pulse_bpm,
              source, measurement_kind, external_origin, external_record_id,
              measured_at, note
            ) VALUES (
              $1, $2, $3, $4,
              'imported_health_record', 'externally_sourced', $5, $6,
              $7, $8
            )
            RETURNING ${RETURNING}
          `,
          [
            auth.userId,
            body.systolic,
            body.diastolic,
            body.pulseBpm ?? null,
            body.externalOrigin,
            body.externalRecordId,
            measuredAt.toISOString(),
            body.note ?? null,
          ],
        );
        const created = inserted.rows[0];
        if (!created) throw new Error("Blood pressure import returned no row");
        return { row: created, created: true };
      });

      return reply.code(outcome.created ? 201 : 200).send(
        bloodPressureResponseSchema.parse({
          reading: serialize(outcome.row),
        }),
      );
    },
  );

  app.delete(
    "/v1/blood-pressure/:id",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const { id } = request.params as { id: string };
      const deleted = await pool.query(
        "DELETE FROM blood_pressure_readings WHERE id = $1 AND user_id = $2",
        [id, auth.userId],
      );
      if (deleted.rowCount === 0) {
        throw new ApiError(404, "NOT_FOUND", "No such reading.");
      }
      return reply.code(204).send();
    },
  );
}

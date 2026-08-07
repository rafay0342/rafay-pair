import type { FastifyInstance } from "fastify";

import {
  consentCapabilities,
  updateConsentsRequestSchema,
  type ConsentResponse,
} from "@rafay-pair/api-contracts";
import { SessionCoordinator } from "@rafay-pair/session-coordinator";

import { withTransaction } from "../database.js";
import { authGuard, mutationGuard } from "../guards.js";
import { authenticated } from "../types.js";

interface ConsentRow {
  capability: (typeof consentCapabilities)[number];
  granted: boolean;
  updated_at: Date;
}

export async function registerConsentRoutes(
  app: FastifyInstance,
): Promise<void> {
  const dependencies = app.dependencies;
  const { pool } = dependencies;

  app.get(
    "/v1/consents",
    { preHandler: authGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const pair = await new SessionCoordinator(pool).getActivePair(
        auth.userId,
      );
      return reply.send(
        await readConsentResponse(
          pool,
          pair.pairId,
          auth.userId,
          pair.partnerUserId,
        ),
      );
    },
  );

  app.put(
    "/v1/consents",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const body = updateConsentsRequestSchema.parse(request.body);
      const response = await withTransaction(pool, async (client) => {
        const pair = await new SessionCoordinator(client).getActivePair(
          auth.userId,
          true,
        );
        for (const grant of body.grants) {
          const existing = await client.query<{ granted: boolean }>(
            `
            SELECT granted FROM consent_grants
            WHERE pair_id = $1 AND grantor_user_id = $2
              AND grantee_user_id = $3 AND capability = $4
            FOR UPDATE
          `,
            [pair.pairId, auth.userId, pair.partnerUserId, grant.capability],
          );
          const previous = existing.rows[0]?.granted;
          if (previous === undefined) {
            throw new Error(
              "Default-deny consent row is missing for active pair",
            );
          }
          if (previous === grant.granted) continue;
          await client.query(
            `
            UPDATE consent_grants SET granted = $5, updated_at = now()
            WHERE pair_id = $1 AND grantor_user_id = $2
              AND grantee_user_id = $3 AND capability = $4
          `,
            [
              pair.pairId,
              auth.userId,
              pair.partnerUserId,
              grant.capability,
              grant.granted,
            ],
          );
          await client.query(
            `
            INSERT INTO consent_audit_log (
              pair_id, grantor_user_id, grantee_user_id, capability,
              previous_granted, new_granted, actor_user_id, reason
            ) VALUES ($1, $2, $3, $4, $5, $6, $2, 'user_consent_center')
          `,
            [
              pair.pairId,
              auth.userId,
              pair.partnerUserId,
              grant.capability,
              previous,
              grant.granted,
            ],
          );
        }
        return readConsentResponse(
          client,
          pair.pairId,
          auth.userId,
          pair.partnerUserId,
        );
      });
      return reply.send(response);
    },
  );
}

async function readConsentResponse(
  database: Parameters<typeof readRows>[0],
  pairId: string,
  grantorUserId: string,
  granteeUserId: string,
): Promise<ConsentResponse> {
  const rows = await readRows(database, pairId, grantorUserId, granteeUserId);
  const byCapability = new Map(rows.map((row) => [row.capability, row]));
  return {
    pairId,
    grantorUserId,
    granteeUserId,
    grants: consentCapabilities.map((capability) => {
      const row = byCapability.get(capability);
      if (!row)
        throw new Error(`Missing durable consent row for ${capability}`);
      return {
        capability,
        granted: row.granted,
        updatedAt: row.updated_at.toISOString(),
      };
    }),
  };
}

interface ConsentQueryable {
  query<T extends ConsentRow>(
    text: string,
    values: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

async function readRows(
  database: ConsentQueryable,
  pairId: string,
  grantorUserId: string,
  granteeUserId: string,
): Promise<ConsentRow[]> {
  const result = await database.query<ConsentRow>(
    `
      SELECT capability, granted, updated_at
      FROM consent_grants
      WHERE pair_id = $1 AND grantor_user_id = $2 AND grantee_user_id = $3
    `,
    [pairId, grantorUserId, granteeUserId],
  );
  return result.rows;
}

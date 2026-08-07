import type { ConsentCapability } from "@rafay-pair/api-contracts";
import type { QueryResult, QueryResultRow } from "pg";

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export interface ActivePairContext {
  pairId: string;
  actorUserId: string;
  partnerUserId: string;
  actorPaused: boolean;
  partnerPaused: boolean;
}

export type AuthorizationFailure =
  "PAIR_REQUIRED" | "PAIR_INACTIVE" | "PRIVACY_PAUSED" | "CONSENT_DENIED";

export class SessionAuthorizationError extends Error {
  public constructor(public readonly code: AuthorizationFailure) {
    super(code);
    this.name = "SessionAuthorizationError";
  }
}

interface PairContextRow extends QueryResultRow {
  pair_id: string;
  status: string;
  actor_user_id: string;
  partner_user_id: string | null;
  actor_paused: boolean;
  partner_paused: boolean;
}

export class SessionCoordinator {
  public constructor(private readonly database: Queryable) {}

  public async getActivePair(
    userId: string,
    lock = false,
  ): Promise<ActivePairContext> {
    let lockedPairId: string | undefined;
    if (lock) {
      const locked = await this.database.query<{ pair_id: string }>(
        `
          SELECT p.id AS pair_id
          FROM pair_members actor
          JOIN pairs p ON p.id = actor.pair_id
          WHERE actor.user_id = $1
            AND actor.left_at IS NULL
            AND p.disconnected_at IS NULL
          FOR UPDATE OF p
        `,
        [userId],
      );
      lockedPairId = locked.rows[0]?.pair_id;
      if (!lockedPairId) {
        throw new SessionAuthorizationError("PAIR_REQUIRED");
      }
    }
    const result = await this.database.query<PairContextRow>(
      `
        SELECT
          p.id AS pair_id,
          p.status,
          actor.user_id AS actor_user_id,
          partner.user_id AS partner_user_id,
          COALESCE(actor_privacy.paused, false) AS actor_paused,
          COALESCE(partner_privacy.paused, false) AS partner_paused
        FROM pair_members actor
        JOIN pairs p ON p.id = actor.pair_id
        LEFT JOIN pair_members partner
          ON partner.pair_id = p.id
          AND partner.user_id <> actor.user_id
          AND partner.left_at IS NULL
        LEFT JOIN privacy_states actor_privacy
          ON actor_privacy.pair_id = p.id AND actor_privacy.user_id = actor.user_id
        LEFT JOIN privacy_states partner_privacy
          ON partner_privacy.pair_id = p.id AND partner_privacy.user_id = partner.user_id
        WHERE actor.user_id = $1
          AND actor.left_at IS NULL
          AND p.disconnected_at IS NULL
          AND ($2::uuid IS NULL OR p.id = $2)
      `,
      [userId, lockedPairId ?? null],
    );
    const row = result.rows[0];
    if (!row) {
      throw new SessionAuthorizationError("PAIR_REQUIRED");
    }
    if (row.status !== "active" || !row.partner_user_id) {
      throw new SessionAuthorizationError("PAIR_INACTIVE");
    }
    return {
      pairId: row.pair_id,
      actorUserId: row.actor_user_id,
      partnerUserId: row.partner_user_id,
      actorPaused: row.actor_paused,
      partnerPaused: row.partner_paused,
    };
  }

  public async authorizePartnerAction(
    actorUserId: string,
    capability: ConsentCapability,
  ): Promise<ActivePairContext> {
    const pair = await this.getActivePair(actorUserId, true);
    if (pair.actorPaused || pair.partnerPaused) {
      throw new SessionAuthorizationError("PRIVACY_PAUSED");
    }

    // The recipient/grantor controls whether the actor/grantee may perform the action.
    const result = await this.database.query<{ granted: boolean }>(
      `
        SELECT granted
        FROM consent_grants
        WHERE pair_id = $1
          AND grantor_user_id = $2
          AND grantee_user_id = $3
          AND capability = $4
      `,
      [pair.pairId, pair.partnerUserId, actorUserId, capability],
    );
    if (result.rows[0]?.granted !== true) {
      throw new SessionAuthorizationError("CONSENT_DENIED");
    }
    return pair;
  }

  public async authorizeSharing(
    ownerUserId: string,
    capability: Exclude<ConsentCapability, "care_requests">,
  ): Promise<ActivePairContext> {
    const pair = await this.getActivePair(ownerUserId, true);
    if (pair.actorPaused || pair.partnerPaused) {
      throw new SessionAuthorizationError("PRIVACY_PAUSED");
    }
    const result = await this.database.query<{ granted: boolean }>(
      `
        SELECT granted
        FROM consent_grants
        WHERE pair_id = $1
          AND grantor_user_id = $2
          AND grantee_user_id = $3
          AND capability = $4
      `,
      [pair.pairId, ownerUserId, pair.partnerUserId, capability],
    );
    if (result.rows[0]?.granted !== true) {
      throw new SessionAuthorizationError("CONSENT_DENIED");
    }
    return pair;
  }
}

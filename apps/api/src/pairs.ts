import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { Pair } from "@rafay-pair/api-contracts";

interface PairRow extends QueryResultRow {
  id: string;
  status: "waiting" | "active";
  created_at: Date;
  user_id: string;
  display_name: string;
  joined_at: Date;
}

export async function getCurrentPair(
  database: Pool | PoolClient,
  userId: string,
): Promise<Pair | undefined> {
  const result = await database.query<PairRow>(
    `
      SELECT p.id, p.status, p.created_at, member.user_id, u.display_name, member.joined_at
      FROM pair_members actor
      JOIN pairs p ON p.id = actor.pair_id
      JOIN pair_members member ON member.pair_id = p.id AND member.left_at IS NULL
      JOIN users u ON u.id = member.user_id
      WHERE actor.user_id = $1
        AND actor.left_at IS NULL
        AND p.status IN ('waiting', 'active')
      ORDER BY member.joined_at, member.user_id
    `,
    [userId],
  );
  const first = result.rows[0];
  if (!first) return undefined;
  return {
    id: first.id,
    status: first.status,
    members: result.rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      joinedAt: row.joined_at.toISOString(),
    })),
    createdAt: first.created_at.toISOString(),
  };
}

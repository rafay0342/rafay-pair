import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "./database.js";

const schemaName = `rafay_migration_test_${crypto.randomUUID().replaceAll("-", "")}`;
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://rafay_pair:local-development-only@127.0.0.1:5432/rafay_pair?sslmode=disable";
const admin = new Pool({ connectionString: databaseUrl });
const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schemaName},public`,
});
const migrationsDirectory = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schemaName}`);
  await runMigrations(pool, migrationsDirectory);
});

afterAll(async () => {
  await pool.end().catch(() => undefined);
  await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await admin.end();
});

describe("migration crash recovery", () => {
  it("replaces an invalid concurrent-index residue and then becomes a no-op", async () => {
    const users = await pool.query<{ id: string }>(`
      INSERT INTO users(email, display_name, password_hash)
      VALUES
        ('migration-a@example.test', 'Migration A', 'hash'),
        ('migration-b@example.test', 'Migration B', 'hash')
      RETURNING id
    `);
    const firstUserId = users.rows[0]?.id;
    const secondUserId = users.rows[1]?.id;
    expect(firstUserId).toBeDefined();
    expect(secondUserId).toBeDefined();

    const pair = await pool.query<{ id: string }>(
      `
        INSERT INTO pairs(created_by_user_id, status, activated_at)
        VALUES ($1, 'active', now())
        RETURNING id
      `,
      [firstUserId],
    );
    const pairId = pair.rows[0]?.id;
    expect(pairId).toBeDefined();

    await pool.query(
      `
        INSERT INTO pair_members(pair_id, user_id)
        VALUES ($1, $2), ($1, $3)
      `,
      [pairId, firstUserId, secondUserId],
    );
    await pool.query(
      `
        INSERT INTO care_requests(
          client_request_id,
          pair_id,
          sender_user_id,
          recipient_user_id,
          kind
        )
        VALUES
          (gen_random_uuid(), $1, $2, $3, 'check_in'),
          (gen_random_uuid(), $1, $2, $3, 'check_in')
      `,
      [pairId, firstUserId, secondUserId],
    );

    await pool.query(
      "DROP INDEX CONCURRENTLY care_requests_pending_expiry_idx",
    );
    await expect(
      pool.query(`
        CREATE UNIQUE INDEX CONCURRENTLY care_requests_pending_expiry_idx
          ON care_requests(pair_id)
          WHERE status = 'pending'
      `),
    ).rejects.toThrow(/could not create unique index/u);

    const invalid = await indexState();
    expect(invalid).toMatchObject({
      indisvalid: false,
      indisready: false,
      indislive: true,
    });

    // Model a process failure after non-transactional DDL but before the
    // migration ledger write. The next run must repair, not silently skip.
    await pool.query(
      "DELETE FROM schema_migrations WHERE version = '0006_repair_care_expiry_index.sql'",
    );
    await runMigrations(pool, migrationsDirectory);

    const repaired = await indexState();
    expect(repaired).toMatchObject({
      indisvalid: true,
      indisready: true,
      indislive: true,
    });
    expect(repaired?.indexdef).toMatch(
      /USING btree \(pair_id, expires_at\) WHERE \(status = 'pending'::text\)$/u,
    );

    const repairedOid = repaired?.oid;
    await runMigrations(pool, migrationsDirectory);
    expect((await indexState())?.oid).toBe(repairedOid);
  });
});

async function indexState(): Promise<
  | {
      oid: string;
      indexdef: string;
      indisvalid: boolean;
      indisready: boolean;
      indislive: boolean;
    }
  | undefined
> {
  const result = await pool.query<{
    oid: string;
    indexdef: string;
    indisvalid: boolean;
    indisready: boolean;
    indislive: boolean;
  }>(`
    SELECT indexrelid::text AS oid,
           pg_get_indexdef(indexrelid) AS indexdef,
           indisvalid,
           indisready,
           indislive
    FROM pg_index
    WHERE indexrelid = 'care_requests_pending_expiry_idx'::regclass
  `);
  return result.rows[0];
}

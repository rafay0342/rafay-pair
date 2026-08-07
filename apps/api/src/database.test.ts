import { describe, expect, it } from "vitest";

import {
  createDatabasePool,
  splitNonTransactionalMigration,
} from "./database.js";

describe("non-transactional migration parsing", () => {
  it("splits only on an explicit full-line delimiter", () => {
    const statements = splitNonTransactionalMigration(`
      -- rafay-pair:no-transaction
      DROP INDEX CONCURRENTLY IF EXISTS care_idx;
      -- rafay-pair:next-statement
      CREATE INDEX CONCURRENTLY care_idx ON care_requests(pair_id);
    `);

    expect(statements).toEqual([
      "-- rafay-pair:no-transaction\n      DROP INDEX CONCURRENTLY IF EXISTS care_idx;",
      "CREATE INDEX CONCURRENTLY care_idx ON care_requests(pair_id);",
    ]);
  });

  it("does not split SQL on semicolons or delimiter-like text", () => {
    const sql = `-- rafay-pair:no-transaction\nSELECT '; -- rafay-pair:next-statement';`;
    expect(splitNonTransactionalMigration(sql)).toEqual([sql]);
  });

  it("rejects an empty explicit statement", () => {
    expect(() =>
      splitNonTransactionalMigration(
        "-- rafay-pair:no-transaction\n-- rafay-pair:next-statement\n",
        "0006.sql",
      ),
    ).toThrow(/0006\.sql has an empty statement/u);
  });
});

describe("database TLS configuration", () => {
  it("pins the supplied trust bundle while retaining peer verification", async () => {
    const pool = createDatabasePool(
      "postgresql://database.example.test/rafay_pair?sslmode=verify-full",
      "test-ca-bundle",
    );
    expect(pool.options.ssl).toEqual({
      rejectUnauthorized: true,
      ca: "test-ca-bundle",
    });
    await pool.end();
  });

  it("rejects contradictory CA configuration when TLS is disabled", () => {
    expect(() =>
      createDatabasePool(
        "postgresql://localhost/rafay_pair?sslmode=disable",
        "test-ca-bundle",
      ),
    ).toThrow("cannot be used when TLS is disabled");
  });
});

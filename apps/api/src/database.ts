import { createHash, X509Certificate } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Pool,
  type PoolClient,
  type QueryConfig,
  type QueryResult,
  type QueryResultRow,
} from "pg";

const nonTransactionalStatementDelimiter =
  /^\s*-- rafay-pair:next-statement\s*$/gmu;

export function createDatabasePool(
  databaseUrl: string,
  databaseCaCertificate?: string,
): Pool {
  const parsedDatabaseUrl = new URL(databaseUrl);
  const tlsDisabled =
    parsedDatabaseUrl.searchParams.get("sslmode") === "disable";
  for (const option of [
    "sslmode",
    "ssl",
    "sslcert",
    "sslkey",
    "sslrootcert",
    "uselibpqcompat",
  ]) {
    parsedDatabaseUrl.searchParams.delete(option);
  }
  if (tlsDisabled && databaseCaCertificate) {
    throw new Error(
      "A database CA certificate cannot be used when TLS is disabled",
    );
  }
  return new Pool({
    connectionString: parsedDatabaseUrl.toString(),
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle: false,
    ssl: tlsDisabled
      ? false
      : {
          rejectUnauthorized: true,
          ...(databaseCaCertificate ? { ca: databaseCaCertificate } : {}),
        },
  });
}

export async function loadDatabaseCaCertificate(
  certificatePath: string | undefined,
): Promise<string | undefined> {
  if (!certificatePath) return undefined;
  const certificateBundle = await readFile(certificatePath, "utf8");
  const size = Buffer.byteLength(certificateBundle, "utf8");
  const certificates = certificateBundle.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu,
  );
  if (
    size < 512 ||
    size > 1_000_000 ||
    !certificates ||
    certificates.length === 0 ||
    certificates.length > 256 ||
    certificates.join("\n").replaceAll(/\s+/gu, "") !==
      certificateBundle.replaceAll(/\s+/gu, "")
  ) {
    throw new Error(
      "DATABASE_CA_CERT_PATH does not contain a valid PEM bundle",
    );
  }
  try {
    for (const encoded of certificates) {
      const certificate = new X509Certificate(encoded);
      if (!certificate.ca || !certificate.verify(certificate.publicKey)) {
        throw new Error("not a self-signed root CA");
      }
    }
  } catch {
    throw new Error(
      "DATABASE_CA_CERT_PATH must contain only valid self-signed root CA certificates",
    );
  }
  return certificateBundle;
}

export async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function runMigrations(
  pool: Pool,
  migrationsDirectory = defaultMigrationsDirectory(),
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtext('rafay_pair_schema_migrations'))",
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const files = (await readdir(migrationsDirectory))
      .filter((file) => /^\d+.*\.sql$/.test(file))
      .sort();
    for (const file of files) {
      const sql = await readFile(path.join(migrationsDirectory, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE version = $1",
        [file],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Applied migration ${file} has changed`);
        }
        continue;
      }
      const isNonTransactional =
        /^\s*-- rafay-pair:no-transaction(?:\r?\n|$)/u.test(sql);
      if (isNonTransactional) {
        // PostgreSQL operations such as CREATE INDEX CONCURRENTLY reject an
        // explicit transaction. The migration must be retry-safe because the
        // schema operation and its ledger insert cannot be atomic.
        for (const statement of splitNonTransactionalMigration(sql, file)) {
          // The explicit delimiter is the only supported split point. Extended
          // query mode additionally rejects an accidental multi-command chunk,
          // so concurrent DDL cannot be wrapped in an implicit transaction.
          await client.query({
            text: statement,
            queryMode: "extended",
          } as QueryConfig);
        }
        await client.query(
          "INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)",
          [file, checksum],
        );
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)",
          [file, checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client
      .query(
        "SELECT pg_advisory_unlock(hashtext('rafay_pair_schema_migrations'))",
      )
      .catch(() => undefined);
    client.release();
  }
}

export function splitNonTransactionalMigration(
  sql: string,
  migrationName = "migration",
): string[] {
  const statements = sql.split(nonTransactionalStatementDelimiter);
  if (statements.some((statement) => statement.trim().length === 0)) {
    throw new Error(
      `Non-transactional ${migrationName} has an empty statement around the explicit delimiter`,
    );
  }
  return statements.map((statement) => statement.trim());
}

export async function applyRuntimeDatabaseGrants(pool: Pool): Promise<void> {
  const runtimeRole = await pool.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rafay_pair_runtime') AS exists",
  );
  if (runtimeRole.rows[0]?.exists !== true) {
    throw new Error(
      "Required NOLOGIN database role rafay_pair_runtime has not been provisioned",
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("GRANT USAGE ON SCHEMA public TO rafay_pair_runtime");
    await client.query(`
      GRANT SELECT, INSERT, UPDATE ON
        users,
        auth_sessions,
        pairs,
        pair_members,
        privacy_states,
        consent_grants,
        care_requests,
        realtime_events,
        outbox_events,
        notification_devices,
        notification_deliveries,
        device_integrity_challenges,
        app_attest_keys,
        app_attest_challenge_bindings
      TO rafay_pair_runtime
    `);
    await client.query(`
      GRANT DELETE ON device_integrity_challenges TO rafay_pair_runtime
    `);
    await client.query(`
      GRANT SELECT, INSERT ON device_integrity_assessments TO rafay_pair_runtime
    `);
    await client.query(`
      GRANT INSERT ON
        consent_audit_log,
        privacy_audit_log,
        security_audit_log
      TO rafay_pair_runtime
    `);
    await client.query(`
      GRANT USAGE, SELECT ON
        consent_audit_log_id_seq,
        privacy_audit_log_id_seq,
        realtime_events_id_seq,
        outbox_events_id_seq,
        security_audit_log_id_seq
      TO rafay_pair_runtime
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function queryOne<R extends QueryResultRow>(
  client: Pool | PoolClient,
  text: string,
  values: readonly unknown[],
): Promise<R | undefined> {
  const result: QueryResult<R> = await client.query<R>(text, [...values]);
  return result.rows[0];
}

function defaultMigrationsDirectory(): string {
  return fileURLToPath(new URL("../migrations", import.meta.url));
}

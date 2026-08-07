import { z } from "zod";
import { isAbsolute } from "node:path";

import { validateDatabaseTransport } from "./config.js";
import {
  applyRuntimeDatabaseGrants,
  createDatabasePool,
  loadDatabaseCaCertificate,
  runMigrations,
} from "./database.js";

const migrationEnvironment = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DATABASE_URL: z.string().url(),
    DATABASE_CA_CERT_PATH: z.preprocess(
      // Container images bake a production default; local compose clears it
      // with an empty value because TLS-disabled URLs reject a CA bundle.
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().trim().min(1).max(1_024).optional(),
    ),
  })
  .parse(process.env);
validateDatabaseTransport(
  migrationEnvironment.DATABASE_URL,
  migrationEnvironment.NODE_ENV,
);
if (
  migrationEnvironment.NODE_ENV === "production" &&
  !migrationEnvironment.DATABASE_CA_CERT_PATH
) {
  throw new Error(
    "DATABASE_CA_CERT_PATH is required for verified production database TLS",
  );
}
if (
  migrationEnvironment.DATABASE_CA_CERT_PATH &&
  !isAbsolute(migrationEnvironment.DATABASE_CA_CERT_PATH)
) {
  throw new Error("DATABASE_CA_CERT_PATH must be an absolute path");
}
const databaseCaCertificate = await loadDatabaseCaCertificate(
  migrationEnvironment.DATABASE_CA_CERT_PATH,
);
const pool = createDatabasePool(
  migrationEnvironment.DATABASE_URL,
  databaseCaCertificate,
);

try {
  await runMigrations(pool);
  if (migrationEnvironment.NODE_ENV === "production") {
    await applyRuntimeDatabaseGrants(pool);
  }
} finally {
  await pool.end();
}

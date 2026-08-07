import "./telemetry.js";

import { buildApi } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabasePool, loadDatabaseCaCertificate } from "./database.js";
import { shutdownTelemetry } from "./telemetry.js";

const config = loadConfig();
const databaseCaCertificate = await loadDatabaseCaCertificate(
  config.databaseCaCertificatePath,
);
const pool = createDatabasePool(config.databaseUrl, databaseCaCertificate);

try {
  const app = await buildApi({ config, pool });
  const close = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await pool.end();
    await shutdownTelemetry();
    process.exitCode = 0;
  };
  process.once("SIGTERM", () => void close("SIGTERM"));
  process.once("SIGINT", () => void close("SIGINT"));
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  console.error(error);
  await pool.end();
  await shutdownTelemetry();
  process.exitCode = 1;
}

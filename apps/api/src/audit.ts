import type { Pool, PoolClient } from "pg";

import { tokenHash } from "./security.js";
import type { ApiConfig } from "./config.js";

export async function recordSecurityAudit(
  database: Pool | PoolClient,
  config: ApiConfig,
  input: {
    actorUserId?: string;
    action: string;
    targetType?: string;
    targetId?: string;
    requestId?: string;
    ip?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await database.query(
    `
      INSERT INTO security_audit_log (
        actor_user_id, action, target_type, target_id, request_id, ip_hash, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      input.actorUserId ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      input.requestId ?? null,
      input.ip ? tokenHash(input.ip, config.sessionPepper) : null,
      input.metadata ?? {},
    ],
  );
}

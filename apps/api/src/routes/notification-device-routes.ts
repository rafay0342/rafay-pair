import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { registerNotificationDeviceSchema } from "@rafay-pair/api-contracts";
import {
  deriveDeviceEncryptionKey,
  encryptDeviceToken,
} from "@rafay-pair/notifications";

import { recordSecurityAudit } from "../audit.js";
import { withTransaction } from "../database.js";
import { ApiError } from "../errors.js";
import { mutationGuard } from "../guards.js";
import { tokenHash } from "../security.js";
import { authenticated } from "../types.js";

const maximumActiveDevicesPerUser = 5;
const deviceRegistrationLifetimeDays = 90;
const deviceIdSchema = z.string().uuid();

export async function registerNotificationDeviceRoutes(
  app: FastifyInstance,
): Promise<void> {
  const dependencies = app.dependencies;
  const { config, pool } = dependencies;
  const encryptionKey = deriveDeviceEncryptionKey(
    config.sessionPepper,
    config.deviceTokenEncryptionKey,
  );

  app.post(
    "/v1/notification-devices",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      if (auth.platform === "web") {
        throw new ApiError(
          400,
          "PLATFORM_NOT_SUPPORTED",
          "Web push registration is not supported by this endpoint",
        );
      }
      const body = registerNotificationDeviceSchema.parse(request.body);
      if (body.platform !== auth.platform) {
        throw new ApiError(
          400,
          "PLATFORM_MISMATCH",
          "Notification platform does not match the authenticated session",
        );
      }
      const hash = tokenHash(body.token, config.sessionPepper);
      const ciphertext = encryptDeviceToken(body.token, encryptionKey);
      const row = await withTransaction(pool, async (client) => {
        // Token and user locks serialize rotations and cap checks across API
        // replicas without retaining the provider token in lock metadata.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 1))",
          [hash],
        );
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 3))",
          [body.installationId],
        );
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 2))",
          [auth.userId],
        );
        await client.query(
          `
            UPDATE notification_devices
            SET disabled_at = COALESCE(disabled_at, now()), updated_at = now()
            WHERE disabled_at IS NULL
              AND (token_hash = $1 OR installation_id = $2)
          `,
          [hash, body.installationId],
        );
        const active = await client.query<{ count: string }>(
          `
            SELECT count(*)::text AS count
            FROM notification_devices
            WHERE user_id = $1 AND disabled_at IS NULL AND expires_at > now()
          `,
          [auth.userId],
        );
        if (Number(active.rows[0]?.count ?? 0) >= maximumActiveDevicesPerUser) {
          throw new ApiError(
            429,
            "DEVICE_LIMIT_REACHED",
            "Active device limit reached",
            "Remove an existing installation before registering another device.",
          );
        }
        const result = await client.query<{
          id: string;
          created_at: Date;
          updated_at: Date;
          expires_at: Date;
        }>(
          `
            INSERT INTO notification_devices(
              user_id, platform, installation_id, session_family_id,
              token_hash, token_ciphertext, last_seen_at, expires_at
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, now(),
              now() + ($7 * interval '1 day')
            )
            RETURNING id, created_at, updated_at, expires_at
          `,
          [
            auth.userId,
            body.platform,
            body.installationId,
            auth.familyId,
            hash,
            ciphertext,
            deviceRegistrationLifetimeDays,
          ],
        );
        const registered = result.rows[0];
        if (!registered)
          throw new Error("Notification device insert returned no row");
        await recordSecurityAudit(client, config, {
          actorUserId: auth.userId,
          action: "notification_device.register",
          targetType: "notification_device",
          targetId: registered.id,
          requestId: request.id,
          ip: request.ip,
          metadata: { platform: body.platform },
        });
        return registered;
      });
      return reply.status(201).send({
        device: {
          id: row.id,
          platform: body.platform,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
          expiresAt: row.expires_at.toISOString(),
        },
      });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/v1/notification-devices/:id",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const deviceId = deviceIdSchema.parse(request.params.id);
      await withTransaction(pool, async (client) => {
        const result = await client.query(
          `
            UPDATE notification_devices
            SET disabled_at = now(), updated_at = now()
            WHERE id = $1 AND user_id = $2 AND disabled_at IS NULL
          `,
          [deviceId, auth.userId],
        );
        if (result.rowCount === 0)
          throw new ApiError(
            404,
            "DEVICE_NOT_FOUND",
            "Notification device not found",
          );
        await recordSecurityAudit(client, config, {
          actorUserId: auth.userId,
          action: "notification_device.disable",
          targetType: "notification_device",
          targetId: deviceId,
          requestId: request.id,
          ip: request.ip,
        });
      });
      return reply.status(204).send();
    },
  );
}

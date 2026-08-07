import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { QueryResultRow } from "pg";

import {
  loginRequestSchema,
  logoutRequestSchema,
  refreshRequestSchema,
  registerRequestSchema,
  type User,
} from "@rafay-pair/api-contracts";

import {
  authenticateRequest,
  clearSessionCookies,
  clientPlatform,
  createSession,
  ensureTrustedWebOrigin,
  findRefreshSession,
  issueAnonymousCsrf,
  refreshCookieName,
  sendAuthResponse,
  sessionUser,
  verifyAnonymousWebCsrf,
  verifyWebCsrfForHash,
} from "../auth.js";
import { recordSecurityAudit } from "../audit.js";
import { withTransaction } from "../database.js";
import { ApiError } from "../errors.js";
import { disableNotificationDevicesForSessionFamily } from "../notification-devices.js";
import { hashPassword, verifyPassword } from "../security.js";
import { authenticated } from "../types.js";

interface UserWithPasswordRow extends QueryResultRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  created_at: Date;
  disabled_at: Date | null;
}

const dummyPasswordHash = hashPassword("rafay-pair-dummy-password-90210");

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const { config, pool } = app.dependencies;

  app.get("/v1/auth/csrf", async (_request, reply) => {
    const csrfToken = issueAnonymousCsrf(reply, config);
    return reply.header("cache-control", "no-store").send({ csrfToken });
  });

  app.post(
    "/v1/auth/register",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const platform = clientPlatform(request);
      if (platform === "web") {
        ensureTrustedWebOrigin(request, config);
        verifyAnonymousWebCsrf(request, config);
      }
      const body = registerRequestSchema.parse(request.body);
      const passwordHash = await hashPassword(body.password);
      const result = await withTransaction(pool, async (client) => {
        const inserted = await client.query<UserWithPasswordRow>(
          `
            INSERT INTO users(email, display_name, password_hash)
            VALUES ($1, $2, $3)
            RETURNING id, email::text, display_name, password_hash, created_at, disabled_at
          `,
          [body.email, body.displayName, passwordHash],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error("User insert returned no row");
        const session = await createSession(
          client,
          row.id,
          platform,
          config.sessionPepper,
        );
        await recordSecurityAudit(client, config, {
          actorUserId: row.id,
          action: "auth.register",
          targetType: "user",
          targetId: row.id,
          requestId: request.id,
          ip: request.ip,
          metadata: { platform },
        });
        return { user: publicUser(row), session };
      });
      return reply
        .status(201)
        .send(
          sendAuthResponse(
            reply,
            result.user,
            result.session,
            platform,
            config,
          ),
        );
    },
  );

  app.post(
    "/v1/auth/login",
    { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const platform = clientPlatform(request);
      if (platform === "web") {
        ensureTrustedWebOrigin(request, config);
        verifyAnonymousWebCsrf(request, config);
      }
      const body = loginRequestSchema.parse(request.body);
      const result = await pool.query<UserWithPasswordRow>(
        `
          SELECT id, email::text, display_name, password_hash, created_at, disabled_at
          FROM users WHERE email = $1
        `,
        [body.email],
      );
      const row = result.rows[0];
      const validPassword = await verifyPassword(
        row?.password_hash ?? (await dummyPasswordHash),
        body.password,
      );
      if (!row || !validPassword || row.disabled_at) {
        await recordSecurityAudit(pool, config, {
          action: "auth.login_failed",
          requestId: request.id,
          ip: request.ip,
          metadata: { platform },
        });
        throw invalidCredentials();
      }
      const session = await withTransaction(pool, async (client) => {
        const created = await createSession(
          client,
          row.id,
          platform,
          config.sessionPepper,
        );
        await recordSecurityAudit(client, config, {
          actorUserId: row.id,
          action: "auth.login",
          targetType: "session",
          targetId: created.id,
          requestId: request.id,
          ip: request.ip,
          metadata: { platform },
        });
        return created;
      });
      return reply.send(
        sendAuthResponse(reply, publicUser(row), session, platform, config),
      );
    },
  );

  app.post(
    "/v1/auth/refresh",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const platform = clientPlatform(request);
      if (platform === "web") ensureTrustedWebOrigin(request, config);
      const body = refreshRequestSchema.parse(request.body ?? {});
      const refreshToken =
        platform === "web"
          ? request.cookies[refreshCookieName]
          : body.refreshToken;
      if (!refreshToken) throw invalidCredentials();

      const result = await withTransaction(pool, async (client) => {
        const previous = await findRefreshSession(client, refreshToken, config);
        if (
          !previous ||
          previous.client_platform !== platform ||
          previous.disabled_at
        )
          throw invalidCredentials();
        if (platform === "web")
          verifyWebCsrfForHash(request, config, previous.csrf_token_hash);
        if (previous.revoked_at || previous.replaced_by_session_id) {
          await client.query(
            "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = 'refresh_reuse' WHERE family_id = $1",
            [previous.family_id],
          );
          await disableNotificationDevicesForSessionFamily(
            client,
            previous.family_id,
          );
          await recordSecurityAudit(client, config, {
            actorUserId: previous.user_id,
            action: "auth.refresh_reuse_detected",
            targetType: "session_family",
            targetId: previous.family_id,
            requestId: request.id,
            ip: request.ip,
          });
          return { invalid: true as const };
        }
        if (previous.refresh_expires_at <= new Date()) {
          await client.query(
            "UPDATE auth_sessions SET revoked_at = now(), revoke_reason = 'refresh_expired' WHERE id = $1",
            [previous.id],
          );
          await disableNotificationDevicesForSessionFamily(
            client,
            previous.family_id,
          );
          return { invalid: true as const };
        }
        const next = await createSession(
          client,
          previous.user_id,
          platform,
          config.sessionPepper,
          previous.family_id,
          previous.id,
        );
        await client.query(
          `
            UPDATE auth_sessions
            SET revoked_at = now(), revoke_reason = 'rotated', replaced_by_session_id = $2
            WHERE id = $1
          `,
          [previous.id, next.id],
        );
        await recordSecurityAudit(client, config, {
          actorUserId: previous.user_id,
          action: "auth.refresh",
          targetType: "session",
          targetId: next.id,
          requestId: request.id,
          ip: request.ip,
          metadata: { previousSessionId: previous.id },
        });
        return {
          invalid: false as const,
          user: sessionUser(previous),
          session: next,
        };
      });
      if (result.invalid) throw invalidCredentials();
      return reply.send(
        sendAuthResponse(reply, result.user, result.session, platform, config),
      );
    },
  );

  app.post("/v1/auth/logout", async (request, reply) => {
    const platform = clientPlatform(request);
    if (platform === "web") ensureTrustedWebOrigin(request, config);
    const body = logoutRequestSchema.parse(request.body ?? {});
    const refreshToken =
      platform === "web"
        ? request.cookies[refreshCookieName]
        : body.refreshToken;

    await withTransaction(pool, async (client) => {
      if (refreshToken) {
        const session = await findRefreshSession(client, refreshToken, config);
        if (session && session.client_platform === platform) {
          if (platform === "web")
            verifyWebCsrfForHash(request, config, session.csrf_token_hash);
          await client.query(
            "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = 'logout' WHERE family_id = $1",
            [session.family_id],
          );
          await disableNotificationDevicesForSessionFamily(
            client,
            session.family_id,
          );
          await recordSecurityAudit(client, config, {
            actorUserId: session.user_id,
            action: "auth.logout",
            targetType: "session_family",
            targetId: session.family_id,
            requestId: request.id,
            ip: request.ip,
          });
        } else if (platform === "web") {
          // Invalid Web credentials must not provide a CSRF bypass oracle.
          verifyAnonymousWebCsrf(request, config);
        }
      } else if (platform === "web") {
        verifyAnonymousWebCsrf(request, config);
      }
    });
    if (platform === "web") clearSessionCookies(reply, config);
    return reply.status(204).send();
  });

  const meHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    await authenticateRequest(request, pool, config);
    const auth = authenticated(request);
    return reply.send({
      user: {
        id: auth.userId,
        email: auth.email,
        displayName: auth.displayName,
        createdAt: auth.userCreatedAt.toISOString(),
      },
    });
  };
  app.get("/v1/auth/me", meHandler);
  app.get("/v1/auth/session", meHandler);
}

function publicUser(row: UserWithPasswordRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at.toISOString(),
  };
}

function invalidCredentials(): ApiError {
  return new ApiError(401, "INVALID_CREDENTIALS", "Invalid credentials");
}

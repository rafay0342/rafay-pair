import { randomUUID } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { AuthResponse, User } from "@rafay-pair/api-contracts";

import { ApiError } from "./errors.js";
import {
  accessTokenLifetimeMs,
  createCsrfToken,
  opaqueToken,
  refreshTokenLifetimeMs,
  secureEqual,
  tokenHash,
  verifyCsrfSignature,
} from "./security.js";
import type { ApiConfig } from "./config.js";
import type { AuthContext, ClientPlatform } from "./types.js";

export const accessCookieName = "rafay_access";
export const refreshCookieName = "rafay_refresh";
export const csrfCookieName = "rafay_csrf";
export const csrfHeaderName = "x-csrf-token";

interface SessionRow extends QueryResultRow {
  id: string;
  family_id: string;
  user_id: string;
  client_platform: ClientPlatform;
  csrf_token_hash: string | null;
  access_expires_at: Date;
  refresh_expires_at: Date;
  revoked_at: Date | null;
  replaced_by_session_id: string | null;
  email: string;
  display_name: string;
  user_created_at: Date;
  disabled_at: Date | null;
}

export interface RawSession {
  id: string;
  familyId: string;
  accessToken: string;
  refreshToken: string;
  csrfToken?: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

export async function authenticateRequest(
  request: FastifyRequest,
  pool: Pool,
  config: ApiConfig,
): Promise<void> {
  const authorization = request.headers.authorization;
  const bearer = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  const cookieToken = request.cookies[accessCookieName];
  if (bearer && cookieToken) {
    throw new ApiError(
      400,
      "AMBIGUOUS_AUTH",
      "Ambiguous authentication",
      "Send either bearer or cookie credentials.",
    );
  }
  const token = bearer ?? cookieToken;
  if (!token) throw unauthorized();

  const result = await pool.query<SessionRow>(
    `
      SELECT
        s.id, s.family_id, s.user_id, s.client_platform, s.csrf_token_hash,
        s.access_expires_at, s.refresh_expires_at, s.revoked_at, s.replaced_by_session_id,
        u.email::text, u.display_name, u.created_at AS user_created_at, u.disabled_at
      FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.access_token_hash = $1
    `,
    [tokenHash(token, config.sessionPepper)],
  );
  const session = result.rows[0];
  if (
    !session ||
    session.revoked_at ||
    session.access_expires_at <= new Date() ||
    session.disabled_at
  ) {
    throw unauthorized();
  }
  if (bearer && session.client_platform === "web") throw unauthorized();
  if (cookieToken && session.client_platform !== "web") throw unauthorized();
  const declaredPlatform = request.headers["x-rafay-client"];
  if (
    declaredPlatform !== undefined &&
    declaredPlatform !== session.client_platform
  )
    throw unauthorized();
  request.authContext = {
    sessionId: session.id,
    familyId: session.family_id,
    userId: session.user_id,
    email: session.email,
    displayName: session.display_name,
    userCreatedAt: session.user_created_at,
    platform: session.client_platform,
    csrfTokenHash: session.csrf_token_hash,
    authenticationMethod: bearer ? "bearer" : "cookie",
  };
  void pool
    .query("UPDATE auth_sessions SET last_used_at = now() WHERE id = $1", [
      session.id,
    ])
    .catch(() => undefined);
}

export function verifyAuthenticatedCsrf(
  request: FastifyRequest,
  config: ApiConfig,
): void {
  const auth = request.authContext;
  if (!auth || auth.authenticationMethod !== "cookie") return;
  verifyCsrf(request, config, auth.csrfTokenHash);
}

export function verifyAnonymousWebCsrf(
  request: FastifyRequest,
  config: ApiConfig,
): void {
  if (clientPlatform(request) !== "web") return;
  verifyCsrf(request, config, null);
}

export function verifyWebCsrfForHash(
  request: FastifyRequest,
  config: ApiConfig,
  expectedHash: string | null,
): void {
  verifyCsrf(request, config, expectedHash);
}

export function issueAnonymousCsrf(
  reply: FastifyReply,
  config: ApiConfig,
): string {
  const token = createCsrfToken(config.sessionPepper);
  setCsrfCookie(reply, token, config, refreshTokenLifetimeMs);
  return token;
}

export function clientPlatform(request: FastifyRequest): ClientPlatform {
  const value = request.headers["x-rafay-client"];
  if (value === "web" || value === "ios" || value === "android") return value;
  throw new ApiError(
    400,
    "CLIENT_PLATFORM_REQUIRED",
    "Client platform is required",
    "Send X-Rafay-Client with web, ios, or android.",
  );
}

export function ensureTrustedWebOrigin(
  request: FastifyRequest,
  config: ApiConfig,
): void {
  if (clientPlatform(request) !== "web") return;
  const origin = request.headers.origin;
  if (!origin || !config.allowedOrigins.includes(origin)) {
    throw new ApiError(
      403,
      "ORIGIN_DENIED",
      "Origin denied",
      "The Web request origin is not allowed.",
    );
  }
}

export async function createSession(
  client: PoolClient,
  userId: string,
  platform: ClientPlatform,
  pepper: string,
  familyId: string = randomUUID(),
  parentSessionId?: string,
): Promise<RawSession> {
  const accessToken = opaqueToken();
  const refreshToken = opaqueToken();
  const csrfToken = platform === "web" ? createCsrfToken(pepper) : undefined;
  const accessExpiresAt = new Date(Date.now() + accessTokenLifetimeMs);
  const refreshExpiresAt = new Date(Date.now() + refreshTokenLifetimeMs);
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO auth_sessions (
        family_id, parent_session_id, user_id, client_platform,
        access_token_hash, refresh_token_hash, csrf_token_hash,
        access_expires_at, refresh_expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `,
    [
      familyId,
      parentSessionId ?? null,
      userId,
      platform,
      tokenHash(accessToken, pepper),
      tokenHash(refreshToken, pepper),
      csrfToken ? tokenHash(csrfToken, pepper) : null,
      accessExpiresAt,
      refreshExpiresAt,
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Session insert returned no id");
  return {
    id,
    familyId,
    accessToken,
    refreshToken,
    ...(csrfToken ? { csrfToken } : {}),
    accessExpiresAt,
    refreshExpiresAt,
  };
}

export function sendAuthResponse(
  reply: FastifyReply,
  user: User,
  session: RawSession,
  platform: ClientPlatform,
  config: ApiConfig,
): AuthResponse {
  if (platform === "web") setSessionCookies(reply, session, config);
  return {
    user,
    session: {
      ...(platform !== "web"
        ? {
            accessToken: session.accessToken,
            refreshToken: session.refreshToken,
          }
        : {}),
      accessTokenExpiresAt: session.accessExpiresAt.toISOString(),
      refreshTokenExpiresAt: session.refreshExpiresAt.toISOString(),
    },
  };
}

export function clearSessionCookies(
  reply: FastifyReply,
  config: ApiConfig,
): void {
  const secure = config.nodeEnv === "production";
  reply.clearCookie(accessCookieName, {
    path: "/",
    secure,
    sameSite: "strict",
  });
  reply.clearCookie(refreshCookieName, {
    path: "/v1/auth",
    secure,
    sameSite: "strict",
  });
  reply.clearCookie(csrfCookieName, { path: "/", secure, sameSite: "strict" });
}

export async function findRefreshSession(
  client: PoolClient,
  refreshToken: string,
  config: ApiConfig,
): Promise<SessionRow | undefined> {
  const result = await client.query<SessionRow>(
    `
      SELECT
        s.id, s.family_id, s.user_id, s.client_platform, s.csrf_token_hash,
        s.access_expires_at, s.refresh_expires_at, s.revoked_at, s.replaced_by_session_id,
        u.email::text, u.display_name, u.created_at AS user_created_at, u.disabled_at
      FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.refresh_token_hash = $1
      FOR UPDATE OF s
    `,
    [tokenHash(refreshToken, config.sessionPepper)],
  );
  return result.rows[0];
}

export function sessionUser(session: SessionRow): User {
  return {
    id: session.user_id,
    email: session.email,
    displayName: session.display_name,
    createdAt: session.user_created_at.toISOString(),
  };
}

function setSessionCookies(
  reply: FastifyReply,
  session: RawSession,
  config: ApiConfig,
): void {
  const secure = config.nodeEnv === "production";
  const common = { secure, sameSite: "strict" as const };
  reply.setCookie(accessCookieName, session.accessToken, {
    ...common,
    httpOnly: true,
    path: "/",
    maxAge: Math.floor(accessTokenLifetimeMs / 1_000),
  });
  reply.setCookie(refreshCookieName, session.refreshToken, {
    ...common,
    httpOnly: true,
    path: "/v1/auth",
    maxAge: Math.floor(refreshTokenLifetimeMs / 1_000),
  });
  if (!session.csrfToken) throw new Error("Web session missing CSRF token");
  setCsrfCookie(reply, session.csrfToken, config, refreshTokenLifetimeMs);
}

function setCsrfCookie(
  reply: FastifyReply,
  token: string,
  config: ApiConfig,
  lifetimeMs: number,
): void {
  reply.setCookie(csrfCookieName, token, {
    httpOnly: false,
    secure: config.nodeEnv === "production",
    sameSite: "strict",
    path: "/",
    maxAge: Math.floor(lifetimeMs / 1_000),
  });
}

function verifyCsrf(
  request: FastifyRequest,
  config: ApiConfig,
  expectedHash: string | null,
): void {
  const cookie = request.cookies[csrfCookieName];
  const header = request.headers[csrfHeaderName];
  if (typeof cookie !== "string" || typeof header !== "string")
    throw csrfError();
  if (
    !secureEqual(cookie, header) ||
    !verifyCsrfSignature(cookie, config.sessionPepper)
  )
    throw csrfError();
  if (
    expectedHash &&
    !secureEqual(tokenHash(cookie, config.sessionPepper), expectedHash)
  )
    throw csrfError();
}

function csrfError(): ApiError {
  return new ApiError(403, "CSRF_VALIDATION_FAILED", "CSRF validation failed");
}

function unauthorized(): ApiError {
  return new ApiError(
    401,
    "AUTHENTICATION_REQUIRED",
    "Authentication required",
  );
}

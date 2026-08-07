import type { FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type {
  ConnectionLeaseStore,
  RealtimeBroker,
  RealtimeTicketStore,
} from "@rafay-pair/realtime";

import type { ApiConfig } from "./config.js";
import type { PlayIntegrityVerifier } from "./play-integrity.js";

export type ClientPlatform = "web" | "ios" | "android";

export interface AuthContext {
  sessionId: string;
  familyId: string;
  userId: string;
  email: string;
  displayName: string;
  userCreatedAt: Date;
  platform: ClientPlatform;
  csrfTokenHash: string | null;
  authenticationMethod: "bearer" | "cookie";
}

export interface AppDependencies {
  config: ApiConfig;
  pool: Pool;
  realtimeBroker: RealtimeBroker;
  ticketStore: RealtimeTicketStore;
  connectionLeaseStore: ConnectionLeaseStore;
  playIntegrityVerifier?: PlayIntegrityVerifier;
}

declare module "fastify" {
  interface FastifyInstance {
    dependencies: AppDependencies;
  }

  interface FastifyRequest {
    authContext?: AuthContext;
  }
}

export function authenticated(request: FastifyRequest): AuthContext {
  if (!request.authContext)
    throw new Error("Authenticated route did not set auth context");
  return request.authContext;
}

import type { FastifyReply, FastifyRequest } from "fastify";

import { authenticateRequest, verifyAuthenticatedCsrf } from "./auth.js";
import { ApiError } from "./errors.js";
import type { AppDependencies } from "./types.js";
import { authenticated } from "./types.js";

export function authGuard(dependencies: AppDependencies) {
  return async (request: FastifyRequest): Promise<void> => {
    await authenticateRequest(request, dependencies.pool, dependencies.config);
  };
}

export function mutationGuard(dependencies: AppDependencies) {
  return async (
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> => {
    await authenticateRequest(request, dependencies.pool, dependencies.config);
    const auth = authenticated(request);
    if (auth.authenticationMethod === "cookie") {
      const origin = request.headers.origin;
      if (!origin || !dependencies.config.allowedOrigins.includes(origin)) {
        throw new ApiError(
          403,
          "ORIGIN_DENIED",
          "Origin denied",
          "The Web request origin is not allowed.",
        );
      }
      verifyAuthenticatedCsrf(request, dependencies.config);
    }
  };
}

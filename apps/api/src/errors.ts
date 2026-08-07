import type { FastifyReply, FastifyRequest } from "fastify";
import { DatabaseError } from "pg";
import { ZodError } from "zod";

import { SessionAuthorizationError } from "@rafay-pair/session-coordinator";

import { recordAuthorizationRefusal } from "./telemetry.js";

export class ApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly title: string,
    detail?: string,
  ) {
    super(detail ?? title);
    this.name = "ApiError";
  }
}

export function sendProblem(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  let status = 500;
  let code = "INTERNAL_ERROR";
  let title = "Internal Server Error";
  let detail: string | undefined;
  let errors: Record<string, string[]> | undefined;

  if (error instanceof ApiError) {
    ({ status, code, title } = error);
    detail = error.message;
  } else if (error instanceof SessionAuthorizationError) {
    const mapped = authorizationProblem(error);
    ({ status, code, title, detail } = mapped);
    // Every authorization refusal passes through here, so this is the one place
    // that sees all of them. The failure code is a small closed set; nothing
    // about who was refused is recorded.
    recordAuthorizationRefusal(error.code);
  } else if (error instanceof ZodError) {
    status = 400;
    code = "VALIDATION_FAILED";
    title = "Request validation failed";
    detail = "One or more request fields are invalid.";
    errors = {};
    for (const issue of error.issues) {
      const key = issue.path.join(".") || "request";
      (errors[key] ??= []).push(issue.message);
    }
  } else if (error instanceof DatabaseError && error.code === "23505") {
    status = 409;
    code = "CONFLICT";
    title = "Resource conflict";
    detail = "The requested operation conflicts with current state.";
  } else if (error instanceof DatabaseError && error.code === "23514") {
    status = 409;
    code = "PAIR_FULL";
    title = "Pair is full";
    detail = "A pair can contain at most two active members.";
  } else if (hasHttpStatus(error)) {
    status = error.statusCode;
    code =
      status === 429
        ? "RATE_LIMITED"
        : status === 413
          ? "PAYLOAD_TOO_LARGE"
          : status === 404
            ? "NOT_FOUND"
            : "BAD_REQUEST";
    title =
      status === 429
        ? "Too many requests"
        : status === 413
          ? "Payload too large"
          : status === 404
            ? "Not found"
            : "Bad request";
    detail = title;
  }

  if (status >= 500) {
    request.log.error({ err: error }, "request failed");
  }
  reply
    .status(status)
    .type("application/problem+json")
    .send({
      type: `https://rafaypair.com/problems/${code.toLowerCase().replaceAll("_", "-")}`,
      title,
      status,
      ...(detail ? { detail } : {}),
      instance: request.url,
      code,
      requestId: request.id,
      ...(errors ? { errors } : {}),
    });
}

function hasHttpStatus(error: unknown): error is { statusCode: number } {
  if (!error || typeof error !== "object") return false;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return (
    typeof statusCode === "number" && statusCode >= 400 && statusCode < 500
  );
}

function authorizationProblem(error: SessionAuthorizationError): {
  status: number;
  code: string;
  title: string;
  detail: string;
} {
  switch (error.code) {
    case "PAIR_REQUIRED":
      return {
        status: 409,
        code: error.code,
        title: "Pair required",
        detail: "Join a pair first.",
      };
    case "PAIR_INACTIVE":
      return {
        status: 409,
        code: error.code,
        title: "Pair is not active",
        detail: "The pair needs two members.",
      };
    case "PRIVACY_PAUSED":
      return {
        status: 403,
        code: error.code,
        title: "Privacy pause is active",
        detail:
          "Partner sharing is disabled while either member has privacy pause enabled.",
      };
    case "CONSENT_DENIED":
      return {
        status: 403,
        code: error.code,
        title: "Consent denied",
        detail: "The required directional consent has not been granted.",
      };
  }
}

import { createHmac } from "node:crypto";

import type { RouteOptions } from "fastify";

interface RedisCommandClient {
  sendCommand(command: readonly string[]): Promise<unknown>;
}

interface RateLimitOptions {
  continueExceeding?: boolean;
  exponentialBackoff?: boolean;
}

interface InternalRouteRateLimitOptions extends RateLimitOptions {
  routeInfo?: {
    method?: string | readonly string[];
    url?: string;
  };
}

type RateLimitChildOptions = RouteOptions & {
  path: string;
  prefix: string;
};

interface RateLimitResult {
  current: number;
  ttl: number;
}

type RateLimitCallback = (
  error: Error | null,
  result?: RateLimitResult,
) => void;

export interface RedisRateLimitStoreInstance {
  incr(
    key: string,
    callback: RateLimitCallback,
    timeWindow: number,
    maximum: number,
  ): void;
  child(routeOptions: RateLimitChildOptions): RedisRateLimitStoreInstance;
}

export interface RedisRateLimitStoreConstructor {
  new (options: object): RedisRateLimitStoreInstance;
}

const incrementScript = `
local key = KEYS[1]
local time_window = tonumber(ARGV[1])
local maximum = tonumber(ARGV[2])
local continue_exceeding = ARGV[3] == "true"
local exponential_backoff = ARGV[4] == "true"
local max_safe_integer = (2 ^ 53) - 1

local current = redis.call("INCR", key)
if current == 1 or (continue_exceeding and current > maximum) then
  redis.call("PEXPIRE", key, time_window)
elseif exponential_backoff and current > maximum then
  local exponent = current - maximum - 1
  time_window = math.min(time_window * (2 ^ exponent), max_safe_integer)
  redis.call("PEXPIRE", key, time_window)
else
  time_window = redis.call("PTTL", key)
end

return {current, time_window}
`;

/**
 * Creates the constructor shape expected by @fastify/rate-limit without adding
 * a second Redis implementation to the API process. All identifiers are HMACed
 * before entering Redis so transient abuse-control keys do not disclose IPs or
 * future account-derived keys to cache operators.
 */
export function createRedisRateLimitStore(
  redis: RedisCommandClient,
  hashingSecret: string,
): RedisRateLimitStoreConstructor {
  return class RedisRateLimitStore implements RedisRateLimitStoreInstance {
    private readonly continueExceeding: boolean;
    private readonly exponentialBackoff: boolean;

    public constructor(
      options: object,
      private readonly keyPrefix = "rafay-pair:rate-limit:global:",
    ) {
      const normalized = options as RateLimitOptions;
      this.continueExceeding = normalized.continueExceeding === true;
      this.exponentialBackoff = normalized.exponentialBackoff === true;
    }

    public incr(
      key: string,
      callback: RateLimitCallback,
      timeWindow: number,
      maximum: number,
    ): void {
      const digest = createHmac("sha256", hashingSecret)
        .update(this.keyPrefix)
        .update("\0")
        .update(key)
        .digest("base64url");
      void redis
        .sendCommand([
          "EVAL",
          incrementScript,
          "1",
          `${this.keyPrefix}${digest}`,
          String(timeWindow),
          String(maximum),
          String(this.continueExceeding),
          String(this.exponentialBackoff),
        ])
        .then((raw) => callback(null, parseRateLimitResult(raw)))
        .catch((error: unknown) => callback(asError(error)));
    }

    public child(routeOptions: RateLimitChildOptions): RedisRateLimitStore {
      // @fastify/rate-limit supplies its merged runtime options here even
      // though its public store interface retains Fastify's RouteOptions type.
      const internal = routeOptions as InternalRouteRateLimitOptions;
      const method = Array.isArray(internal.routeInfo?.method)
        ? internal.routeInfo.method.join("+")
        : (internal.routeInfo?.method ?? "custom");
      const url = internal.routeInfo?.url ?? "custom";
      return new RedisRateLimitStore(
        internal,
        `${this.keyPrefix}${method}:${url}:`,
      );
    }
  };
}

function parseRateLimitResult(raw: unknown): RateLimitResult {
  if (!Array.isArray(raw) || raw.length !== 2) {
    throw new Error("Redis returned an invalid rate-limit result");
  }
  const current = Number(raw[0]);
  const ttl = Number(raw[1]);
  if (
    !Number.isSafeInteger(current) ||
    current < 1 ||
    !Number.isSafeInteger(ttl) ||
    ttl < 0
  ) {
    throw new Error("Redis returned an invalid rate-limit counter");
  }
  return { current, ttl };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Redis rate limit failed");
}

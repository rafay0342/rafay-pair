import { createHash, randomBytes } from "node:crypto";

import {
  realtimeCursorSchema,
  realtimeEventEnvelopeSchema,
  type RealtimeEventEnvelope,
} from "@rafay-pair/api-contracts";
import { createClient, type RedisClientType } from "redis";

export interface TicketClaims {
  userId: string;
  sessionId: string;
  pairId: string;
  lastEventId?: string;
  issuedAt: string;
}

export interface TicketStoreClient {
  sendCommand(command: readonly string[]): Promise<unknown>;
}

export interface RealtimeTicketStoreOptions {
  ttlSeconds?: number;
  maxPendingPerUser?: number;
  maxPendingPerSession?: number;
}

export class RealtimeCapacityError extends Error {
  public constructor(public readonly scope: "user" | "session") {
    super(`Realtime ${scope} capacity exceeded`);
    this.name = "RealtimeCapacityError";
  }
}

export class RealtimeTicketStore {
  private readonly ttlSeconds: number;
  private readonly maxPendingPerUser: number;
  private readonly maxPendingPerSession: number;

  public constructor(
    private readonly redis: TicketStoreClient,
    options: number | RealtimeTicketStoreOptions = {},
  ) {
    const normalized =
      typeof options === "number" ? { ttlSeconds: options } : options;
    this.ttlSeconds = normalized.ttlSeconds ?? 30;
    this.maxPendingPerUser = normalized.maxPendingPerUser ?? 12;
    this.maxPendingPerSession = normalized.maxPendingPerSession ?? 6;
    validateResourceLimits(
      this.ttlSeconds,
      this.maxPendingPerUser,
      this.maxPendingPerSession,
    );
  }

  public async issue(input: Omit<TicketClaims, "issuedAt">): Promise<{
    ticket: string;
    expiresAt: string;
  }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ticket = randomBytes(32).toString("base64url");
      const key = ticketKey(ticket);
      const claims: TicketClaims = {
        ...input,
        issuedAt: new Date().toISOString(),
      };
      const result = await this.redis.sendCommand([
        "EVAL",
        issueTicketScript,
        "3",
        key,
        ticketQuotaKey("user", input.userId),
        ticketQuotaKey("session", input.sessionId),
        JSON.stringify(claims),
        String(this.ttlSeconds),
        String(this.maxPendingPerUser),
        String(this.maxPendingPerSession),
        key,
      ]);
      const outcome = Number(result);
      if (outcome === -1) throw new RealtimeCapacityError("user");
      if (outcome === -2) throw new RealtimeCapacityError("session");
      if (outcome === 1) {
        return {
          ticket,
          expiresAt: new Date(
            Date.now() + this.ttlSeconds * 1_000,
          ).toISOString(),
        };
      }
    }
    throw new Error("Unable to allocate a unique realtime ticket");
  }

  public async consume(ticket: string): Promise<TicketClaims | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
      return null;
    }
    const raw = await this.redis.sendCommand(["GETDEL", ticketKey(ticket)]);
    if (typeof raw !== "string") {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
    if (!isTicketClaims(parsed)) {
      return null;
    }
    return parsed;
  }
}

export interface RealtimeConnectionLease {
  readonly id: string;
  readonly userKey: string;
  readonly sessionKey: string;
}

export interface RealtimeConnectionLeaseStoreOptions {
  ttlSeconds?: number;
  maxConnectionsPerUser?: number;
  maxConnectionsPerSession?: number;
}

export interface ConnectionLeaseStore {
  acquire(userId: string, sessionId: string): Promise<RealtimeConnectionLease>;
  renew(lease: RealtimeConnectionLease): Promise<boolean>;
  release(lease: RealtimeConnectionLease): Promise<void>;
  readonly renewalIntervalMs: number;
}

/**
 * Distributed, expiring connection leases. Only hashes and random lease IDs
 * are stored; a crashed gateway is recovered by Redis expiry.
 */
export class RealtimeConnectionLeaseStore implements ConnectionLeaseStore {
  private readonly ttlMilliseconds: number;
  private readonly maxConnectionsPerUser: number;
  private readonly maxConnectionsPerSession: number;

  public constructor(
    private readonly redis: TicketStoreClient,
    options: RealtimeConnectionLeaseStoreOptions = {},
  ) {
    this.ttlMilliseconds = (options.ttlSeconds ?? 45) * 1_000;
    this.maxConnectionsPerUser = options.maxConnectionsPerUser ?? 4;
    this.maxConnectionsPerSession = options.maxConnectionsPerSession ?? 2;
    validateResourceLimits(
      this.ttlMilliseconds,
      this.maxConnectionsPerUser,
      this.maxConnectionsPerSession,
    );
  }

  public get renewalIntervalMs(): number {
    return Math.max(5_000, Math.floor(this.ttlMilliseconds / 3));
  }

  public async acquire(
    userId: string,
    sessionId: string,
  ): Promise<RealtimeConnectionLease> {
    const lease: RealtimeConnectionLease = {
      id: randomBytes(32).toString("base64url"),
      userKey: connectionLeaseKey("user", userId),
      sessionKey: connectionLeaseKey("session", sessionId),
    };
    const result = Number(
      await this.redis.sendCommand([
        "EVAL",
        acquireLeaseScript,
        "2",
        lease.userKey,
        lease.sessionKey,
        lease.id,
        String(this.ttlMilliseconds),
        String(this.maxConnectionsPerUser),
        String(this.maxConnectionsPerSession),
      ]),
    );
    if (result === -1) throw new RealtimeCapacityError("user");
    if (result === -2) throw new RealtimeCapacityError("session");
    if (result !== 1)
      throw new Error("Unable to acquire realtime connection lease");
    return lease;
  }

  public async renew(lease: RealtimeConnectionLease): Promise<boolean> {
    const result = await this.redis.sendCommand([
      "EVAL",
      renewLeaseScript,
      "2",
      lease.userKey,
      lease.sessionKey,
      lease.id,
      String(this.ttlMilliseconds),
    ]);
    return Number(result) === 1;
  }

  public async release(lease: RealtimeConnectionLease): Promise<void> {
    await this.redis.sendCommand([
      "EVAL",
      releaseLeaseScript,
      "2",
      lease.userKey,
      lease.sessionKey,
      lease.id,
    ]);
  }
}

export class RealtimeBroker {
  private readonly subscriber: RedisClientType;

  public constructor(private readonly publisher: RedisClientType) {
    this.subscriber = publisher.duplicate();
    this.subscriber.on("error", logRedisError);
  }

  public async connect(): Promise<void> {
    if (!this.publisher.isOpen) await this.publisher.connect();
    if (!this.subscriber.isOpen) await this.subscriber.connect();
  }

  public async close(): Promise<void> {
    if (this.subscriber.isOpen) await this.subscriber.close();
    if (this.publisher.isOpen) await this.publisher.close();
  }

  public async publish(event: RealtimeEventEnvelope): Promise<void> {
    const validated = realtimeEventEnvelopeSchema.parse(event);
    const serialized = JSON.stringify(validated);
    // PostgreSQL is the sole durable replay source. Redis is intentionally
    // transient fanout only, so sensitive envelopes cannot accumulate in an
    // unread stream.
    await this.publisher.publish(channelName(event.pairId), serialized);
  }

  public async subscribe(
    pairId: string,
    listener: (event: RealtimeEventEnvelope) => void,
  ): Promise<() => Promise<void>> {
    const channel = channelName(pairId);
    const handler = (message: string): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message) as unknown;
      } catch {
        return;
      }
      const result = realtimeEventEnvelopeSchema.safeParse(parsed);
      if (result.success) listener(result.data);
    };
    await this.subscriber.subscribe(channel, handler);
    return async () => {
      await this.subscriber.unsubscribe(channel, handler);
    };
  }
}

export function createRedisClient(url: string): RedisClientType {
  const client = createClient({
    url,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 10_000,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy(retries) {
        return Math.min(100 * 2 ** retries, 3_000);
      },
    },
  });
  client.on("error", logRedisError);
  return client;
}

function ticketKey(ticket: string): string {
  return `realtime:ticket:${createHash("sha256").update(ticket).digest("hex")}`;
}

function ticketQuotaKey(scope: "user" | "session", id: string): string {
  return `realtime:ticket-quota:${scope}:${hashIdentifier(id)}`;
}

function connectionLeaseKey(scope: "user" | "session", id: string): string {
  return `realtime:lease:${scope}:${hashIdentifier(id)}`;
}

function hashIdentifier(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateResourceLimits(
  ttl: number,
  userLimit: number,
  sessionLimit: number,
): void {
  if (!Number.isSafeInteger(ttl) || ttl <= 0)
    throw new Error("Realtime TTL must be a positive safe integer");
  if (!Number.isInteger(userLimit) || userLimit <= 0)
    throw new Error("Realtime user limit must be a positive integer");
  if (!Number.isInteger(sessionLimit) || sessionLimit <= 0)
    throw new Error("Realtime session limit must be a positive integer");
  if (sessionLimit > userLimit)
    throw new Error("Realtime session limit cannot exceed user limit");
}

function channelName(pairId: string): string {
  return `realtime:pair:${pairId}:events`;
}

function isTicketClaims(value: unknown): value is TicketClaims {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.userId === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.pairId === "string" &&
    (candidate.lastEventId === undefined ||
      realtimeCursorSchema.safeParse(candidate.lastEventId).success) &&
    typeof candidate.issuedAt === "string"
  );
}

function logRedisError(error: Error): void {
  process.stderr.write(
    `${JSON.stringify({ level: "error", component: "redis", message: error.message })}\n`,
  );
}

const issueTicketScript = `
local clock = redis.call('TIME')
local now = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[3]) then return -1 end
if redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[4]) then return -2 end
local stored = redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX')
if not stored then return 0 end
local ttl = tonumber(ARGV[2]) * 1000
local expires = now + ttl
redis.call('ZADD', KEYS[2], expires, ARGV[5])
redis.call('ZADD', KEYS[3], expires, ARGV[5])
redis.call('PEXPIRE', KEYS[2], ttl * 2)
redis.call('PEXPIRE', KEYS[3], ttl * 2)
return 1
`;

const acquireLeaseScript = `
local clock = redis.call('TIME')
local now = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return -1 end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then return -2 end
local expires = now + tonumber(ARGV[2])
redis.call('ZADD', KEYS[1], expires, ARGV[1])
redis.call('ZADD', KEYS[2], expires, ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 2)
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[2]) * 2)
return 1
`;

const renewLeaseScript = `
local clock = redis.call('TIME')
local now = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
local userExpiry = tonumber(redis.call('ZSCORE', KEYS[1], ARGV[1]) or '0')
local sessionExpiry = tonumber(redis.call('ZSCORE', KEYS[2], ARGV[1]) or '0')
if userExpiry <= now or sessionExpiry <= now then
  redis.call('ZREM', KEYS[1], ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  return 0
end
local expires = now + tonumber(ARGV[2])
redis.call('ZADD', KEYS[1], expires, ARGV[1])
redis.call('ZADD', KEYS[2], expires, ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 2)
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[2]) * 2)
return 1
`;

const releaseLeaseScript = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

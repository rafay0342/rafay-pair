import { describe, expect, it } from "vitest";

import { createRedisRateLimitStore } from "./redis-rate-limit-store.js";

describe("Redis rate-limit store", () => {
  it("uses an atomic script and never exposes the input key", async () => {
    const commands: readonly string[][] = [];
    const mutableCommands = commands as string[][];
    const Store = createRedisRateLimitStore(
      {
        sendCommand(command) {
          mutableCommands.push([...command]);
          return Promise.resolve([1, 60_000]);
        },
      },
      "rate-limit-test-secret-that-is-at-least-32-bytes",
    );
    const store = new Store({});

    await expect(
      increment(store, "203.0.113.44", 60_000, 120),
    ).resolves.toEqual({ current: 1, ttl: 60_000 });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.slice(0, 3)).toEqual(["EVAL", expect.any(String), "1"]);
    expect(commands[0]?.join(" ")).not.toContain("203.0.113.44");
    expect(commands[0]?.[3]).toMatch(
      /^rafay-pair:rate-limit:global:[A-Za-z0-9_-]{43}$/u,
    );
  });

  it("isolates route counters and preserves route backoff options", async () => {
    const commands: string[][] = [];
    const Store = createRedisRateLimitStore(
      {
        sendCommand(command) {
          commands.push([...command]);
          return Promise.resolve([3, 15_000]);
        },
      },
      "another-rate-limit-secret-at-least-32-bytes",
    );
    const globalStore = new Store({});
    const routeStore = globalStore.child({
      continueExceeding: true,
      exponentialBackoff: true,
      routeInfo: { method: "POST", url: "/v1/auth/login" },
    } as never);

    await expect(
      increment(routeStore, "client-key", 15_000, 2),
    ).resolves.toEqual({ current: 3, ttl: 15_000 });
    expect(commands[0]?.[3]).toMatch(
      /^rafay-pair:rate-limit:global:POST:\/v1\/auth\/login:[A-Za-z0-9_-]{43}$/u,
    );
    expect(commands[0]?.slice(-4)).toEqual(["15000", "2", "true", "true"]);
  });

  it("fails closed when Redis errors or returns malformed data", async () => {
    const ErrorStore = createRedisRateLimitStore(
      {
        sendCommand() {
          return Promise.reject(new Error("redis unavailable"));
        },
      },
      "rate-limit-error-secret-at-least-32-bytes",
    );
    await expect(
      increment(new ErrorStore({}), "client", 1_000, 1),
    ).rejects.toThrow("redis unavailable");

    const InvalidStore = createRedisRateLimitStore(
      {
        sendCommand() {
          return Promise.resolve([0, -1]);
        },
      },
      "rate-limit-invalid-secret-at-least-32-bytes",
    );
    await expect(
      increment(new InvalidStore({}), "client", 1_000, 1),
    ).rejects.toThrow("invalid rate-limit counter");
  });
});

interface IncrementableStore {
  incr(
    key: string,
    callback: (
      error: Error | null,
      result?: { current: number; ttl: number },
    ) => void,
    timeWindow: number,
    maximum: number,
  ): void;
}

function increment(
  store: IncrementableStore,
  key: string,
  timeWindow: number,
  maximum: number,
): Promise<{ current: number; ttl: number }> {
  return new Promise((resolve, reject) => {
    store.incr(
      key,
      (error, result) => {
        if (error) reject(error);
        else if (result) resolve(result);
        else reject(new Error("Missing rate-limit result"));
      },
      timeWindow,
      maximum,
    );
  });
}

import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRedisRateLimitStore } from "./redis-rate-limit-store.js";

const redis = createClient({
  url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
});

beforeAll(async () => redis.connect());
afterAll(async () => redis.close());

describe("distributed HTTP abuse limits", () => {
  it("shares an atomic request window across API process stores", async () => {
    const Store = createRedisRateLimitStore(
      redis,
      "integration-rate-limit-secret-at-least-thirty-two-bytes",
    );
    const firstProcess = new Store({});
    const secondProcess = new Store({});
    const clientKey = `integration-${crypto.randomUUID()}`;

    await expect(increment(firstProcess, clientKey, 250, 2)).resolves.toEqual({
      current: 1,
      ttl: 250,
    });
    await expect(
      increment(secondProcess, clientKey, 250, 2),
    ).resolves.toMatchObject({ current: 2 });
    await expect(
      increment(firstProcess, clientKey, 250, 2),
    ).resolves.toMatchObject({ current: 3 });

    await expect(
      incrementAfterWindow(secondProcess, clientKey, 250, 2),
    ).resolves.toEqual({
      current: 1,
      ttl: 250,
    });
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

async function incrementAfterWindow(
  store: IncrementableStore,
  key: string,
  timeWindow: number,
  maximum: number,
): Promise<{ current: number; ttl: number }> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const result = await increment(store, key, timeWindow, maximum);
    if (result.current === 1) return result;
    if (Date.now() >= deadline) {
      throw new Error(
        "Redis rate-limit window did not expire within 5 seconds",
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(10, Math.min(result.ttl + 25, 100))),
    );
  }
}

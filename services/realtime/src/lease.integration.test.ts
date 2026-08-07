import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  RealtimeCapacityError,
  RealtimeConnectionLeaseStore,
  RealtimeTicketStore,
} from "./index.js";

const redis = createClient({
  url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
});

beforeAll(async () => redis.connect());
afterAll(async () => redis.close());

describe("distributed realtime resource limits", () => {
  it("atomically caps concurrent user and session connections and releases capacity", async () => {
    const store = new RealtimeConnectionLeaseStore(redis, {
      ttlSeconds: 2,
      maxConnectionsPerUser: 2,
      maxConnectionsPerSession: 1,
    });
    const racingUser = crypto.randomUUID();
    const racingSession = crypto.randomUUID();
    const racing = await Promise.allSettled([
      store.acquire(racingUser, racingSession),
      store.acquire(racingUser, racingSession),
    ]);
    expect(
      racing.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      racing.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const racingLease = racing.find(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof store.acquire>>
      > => result.status === "fulfilled",
    )?.value;
    if (!racingLease)
      throw new Error("atomic lease race did not produce a winner");
    await store.release(racingLease);

    const userId = crypto.randomUUID();
    const first = await store.acquire(userId, crypto.randomUUID());
    const secondSession = crypto.randomUUID();
    const second = await store.acquire(userId, secondSession);
    await expect(
      store.acquire(userId, crypto.randomUUID()),
    ).rejects.toMatchObject({
      scope: "user",
    });
    await expect(
      store.acquire(crypto.randomUUID(), secondSession),
    ).rejects.toMatchObject({
      scope: "session",
    });

    await store.release(second);
    const replacement = await store.acquire(userId, crypto.randomUUID());
    await Promise.all([store.release(first), store.release(replacement)]);
  });

  it("renews live leases and recovers expired leases after a crashed gateway", async () => {
    const store = new RealtimeConnectionLeaseStore(redis, {
      ttlSeconds: 0.2,
      maxConnectionsPerUser: 1,
      maxConnectionsPerSession: 1,
    });
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const lease = await store.acquire(userId, sessionId);
    await expect(store.renew(lease)).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(store.renew(lease)).resolves.toBe(false);
    const recovered = await store.acquire(userId, sessionId);
    await store.release(recovered);
  });

  it("caps outstanding one-time tickets atomically", async () => {
    const store = new RealtimeTicketStore(redis, {
      ttlSeconds: 1,
      maxPendingPerUser: 2,
      maxPendingPerSession: 1,
    });
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const first = await store.issue({
      userId,
      sessionId,
      pairId: crypto.randomUUID(),
    });
    await expect(
      store.issue({ userId, sessionId, pairId: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(RealtimeCapacityError);
    await expect(store.consume(first.ticket)).resolves.toMatchObject({
      userId,
      sessionId,
    });
    // Consumption is deliberately conservative: the issuance slot expires
    // with the short ticket window, preventing rapid mint/consume churn.
    await expect(
      store.issue({ userId, sessionId, pairId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ scope: "session" });
    await expect(
      issueWhenRedisWindowExpires(store, {
        userId,
        sessionId,
        pairId: crypto.randomUUID(),
      }),
    ).resolves.toMatchObject({ ticket: expect.any(String) });
  });
});

async function issueWhenRedisWindowExpires(
  store: RealtimeTicketStore,
  input: { userId: string; sessionId: string; pairId: string },
): ReturnType<RealtimeTicketStore["issue"]> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      return await store.issue(input);
    } catch (error) {
      if (!(error instanceof RealtimeCapacityError) || Date.now() >= deadline)
        throw error;
      // Redis TIME is authoritative for the quota score. Polling avoids an
      // assumption about scheduler latency or alignment with Redis seconds.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

import { describe, expect, it, vi } from "vitest";

import {
  RealtimeBroker,
  RealtimeConnectionLeaseStore,
  RealtimeTicketStore,
  type TicketStoreClient,
} from "./index.js";

class MemoryTicketClient implements TicketStoreClient {
  private readonly values = new Map<string, string>();

  public async sendCommand(
    command: readonly string[],
  ): Promise<string | number | null> {
    if (command[0] === "EVAL") {
      const key = command[3];
      const value = command[6];
      if (!key || !value || this.values.has(key)) return 0;
      this.values.set(key, value);
      return 1;
    }
    const key = command[1];
    if (!key) return null;
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }
}

describe("RealtimeTicketStore", () => {
  it("consumes a ticket exactly once", async () => {
    const store = new RealtimeTicketStore(new MemoryTicketClient());
    const claims = {
      userId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      pairId: crypto.randomUUID(),
    };
    const issued = await store.issue(claims);

    await expect(store.consume(issued.ticket)).resolves.toMatchObject(claims);
    await expect(store.consume(issued.ticket)).resolves.toBeNull();
  });

  it("rejects malformed ticket strings without touching storage", async () => {
    const store = new RealtimeTicketStore(new MemoryTicketClient());
    await expect(store.consume("not-a-ticket")).resolves.toBeNull();
  });
});

describe("RealtimeConnectionLeaseStore", () => {
  it("fails closed when transient coordination is unavailable", async () => {
    const store = new RealtimeConnectionLeaseStore({
      sendCommand: vi.fn().mockRejectedValue(new Error("redis unavailable")),
    });
    await expect(
      store.acquire(crypto.randomUUID(), crypto.randomUUID()),
    ).rejects.toThrow("redis unavailable");
  });
});

describe("RealtimeBroker", () => {
  it("uses transient Pub/Sub without retaining envelopes in a Redis stream", async () => {
    const publish = vi.fn().mockResolvedValue(1);
    const publisher = {
      duplicate: () => ({ on: vi.fn() }),
      publish,
    };
    const broker = new RealtimeBroker(publisher as never);
    const event = {
      version: 1,
      id: crypto.randomUUID(),
      eventId: "1",
      authorizationRevision: "2",
      type: "care.request.created",
      occurredAt: new Date().toISOString(),
      pairId: crypto.randomUUID(),
      payload: {},
    } as const;

    await broker.publish(event);

    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(
      `realtime:pair:${event.pairId}:events`,
      JSON.stringify(event),
    );
    expect("multi" in publisher).toBe(false);
  });
});

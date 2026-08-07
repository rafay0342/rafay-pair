import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import { RealtimeClient } from "../src/realtime/RealtimeClient";

class TestSocket extends EventTarget {
  public readonly url: string;
  public readonly protocols: string[];
  public readonly close = vi.fn(() => {
    this.dispatchEvent(new CloseEvent("close"));
  });

  public constructor(url: string, protocols: string[]) {
    super();
    this.url = url;
    this.protocols = protocols;
  }

  public open(): void {
    this.dispatchEvent(new Event("open"));
  }

  public message(data: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(data) }),
    );
  }
}

describe("RealtimeClient recovery", () => {
  it("requests replay from the last event and ignores duplicate envelopes", async () => {
    const ticket = vi
      .fn<
        (lastEventId?: string) => Promise<{
          ticket: string;
          expiresAt: string;
          webSocketUrl: string;
        }>
      >()
      .mockResolvedValueOnce({
        ticket: "a".repeat(43),
        expiresAt: "2026-08-07T00:01:00.000Z",
        webSocketUrl: "wss://api.example.test/v1/realtime",
      })
      .mockResolvedValueOnce({
        ticket: "b".repeat(43),
        expiresAt: "2026-08-07T00:02:00.000Z",
        webSocketUrl: "wss://api.example.test/v1/realtime",
      });
    const fakeApi = {
      realtimeTicket: ticket,
      realtimeUrl: () => "wss://api.example.test/v1/realtime",
      realtimeProtocols: (value: { ticket: string }) => [
        "rafaypair.v1",
        `rafaypair.ticket.${value.ticket}`,
      ],
    } as unknown as ApiClient;
    const sockets: TestSocket[] = [];
    const delayed: (() => void)[] = [];
    const client = new RealtimeClient({
      api: fakeApi,
      createSocket: (url, protocols) => {
        const socket = new TestSocket(url, protocols);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      random: () => 0.5,
      setDelay: (callback) => {
        delayed.push(callback);
        return delayed.length;
      },
      clearDelay: vi.fn(),
    });
    const events = vi.fn();
    client.subscribe(events);

    client.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const firstSocket = sockets[0];
    expect(firstSocket).toBeDefined();
    firstSocket?.open();
    const envelope = {
      version: 1,
      id: "cb112b89-0b6a-478e-a732-d26df637514c",
      eventId: "1",
      authorizationRevision: "7",
      type: "care.request.created",
      occurredAt: "2026-08-07T00:00:00.000Z",
      pairId: "6ead6528-71a6-49a4-a677-635995cc4857",
      payload: { careRequestId: "314f701e-8aa6-4d22-9fd8-68f37637d54f" },
    } as const;
    firstSocket?.message(envelope);
    firstSocket?.message(envelope);
    expect(events).toHaveBeenCalledOnce();

    firstSocket?.close();
    expect(delayed).toHaveLength(1);
    delayed[0]?.();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    expect(ticket).toHaveBeenNthCalledWith(1, undefined);
    expect(ticket).toHaveBeenNthCalledWith(2, "1");
    expect(new URL(sockets[1]?.url ?? "").search).toBe("");
    expect(sockets[1]?.protocols).toEqual([
      "rafaypair.v1",
      `rafaypair.ticket.${"b".repeat(43)}`,
    ]);
    client.stop();
  });

  it("does not open a socket while the browser is offline", async () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    const ticket = vi.fn();
    const client = new RealtimeClient({
      api: { realtimeTicket: ticket } as unknown as ApiClient,
      createSocket: vi.fn(),
    });

    client.start();
    await Promise.resolve();
    expect(client.getSnapshot().status).toBe("offline");
    expect(ticket).not.toHaveBeenCalled();
    client.stop();
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
  });
});

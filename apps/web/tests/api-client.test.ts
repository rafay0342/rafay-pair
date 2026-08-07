import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "../src/api/client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ApiClient browser security", () => {
  beforeEach(() => {
    document.cookie = "rafay_csrf=csrf-value; Path=/";
  });

  it("uses secure cookies and the CSRF double-submit header for mutations", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        privacy: {
          pairId: "cb112b89-0b6a-478e-a732-d26df637514c",
          userId: "6ead6528-71a6-49a4-a677-635995cc4857",
          paused: true,
          pausedAt: "2026-08-07T00:00:00.000Z",
          updatedAt: "2026-08-07T00:00:00.000Z",
        },
      }),
    );

    await new ApiClient().pausePrivacy();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, request] = fetchMock.mock.calls[0] ?? [];
    expect(request).toMatchObject({
      credentials: "include",
      cache: "no-store",
      method: "POST",
    });
    const headers = new Headers(request?.headers);
    expect(headers.get("X-CSRF-Token")).toBe("csrf-value");
    expect(headers.get("X-Rafay-Client")).toBe("web");
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
  });

  it("does not send an authenticated mutation when the CSRF cookie is absent", async () => {
    document.cookie = "rafay_csrf=; Max-Age=0; Path=/";
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(new ApiClient().pausePrivacy()).rejects.toMatchObject({
      status: 403,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired cookie session once and retries the original request", async () => {
    const auth = {
      user: {
        id: "6ead6528-71a6-49a4-a677-635995cc4857",
        email: "person@example.test",
        displayName: "Person",
        createdAt: "2026-08-07T00:00:00.000Z",
      },
      session: {
        accessTokenExpiresAt: "2026-08-07T01:00:00.000Z",
        refreshTokenExpiresAt: "2026-08-14T01:00:00.000Z",
      },
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ title: "Expired" }, 401))
      .mockResolvedValueOnce(jsonResponse(auth))
      .mockResolvedValueOnce(jsonResponse({ user: auth.user }));

    await expect(new ApiClient().session()).resolves.toEqual({
      user: auth.user,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const refreshRequest = fetchMock.mock.calls[1]?.[0];
    expect(refreshRequest).toBeInstanceOf(URL);
    if (!(refreshRequest instanceof URL)) {
      throw new TypeError("Expected refresh request URL");
    }
    expect(refreshRequest.pathname).toBe("/v1/auth/refresh");
  });

  it("keeps the realtime URL credential-free and sends the ticket as a non-selected protocol", async () => {
    const client = new ApiClient();
    const realtimeTicket = {
      ticket: "a".repeat(43),
      expiresAt: "2026-08-07T00:01:00.000Z",
      webSocketUrl: "ws://127.0.0.1:3000/v1/realtime",
    };
    const url = client.realtimeUrl(realtimeTicket);
    expect(url).toMatch(/^ws:/u);
    expect(new URL(url).search).toBe("");
    expect(client.realtimeProtocols(realtimeTicket)).toEqual([
      "rafaypair.v1",
      `rafaypair.ticket.${realtimeTicket.ticket}`,
    ]);
    expect(() =>
      client.realtimeUrl({
        ...realtimeTicket,
        webSocketUrl: "ws://attacker.example/v1/realtime",
      }),
    ).toThrow("unsafe realtime endpoint");
    expect(localStorage).toHaveLength(0);
  });
});

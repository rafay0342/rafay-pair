import { describe, expect, it } from "vitest";

import { realtimeTicketFromProtocolHeader } from "./realtime-routes.js";

describe("realtime WebSocket protocol credentials", () => {
  const ticket = "A".repeat(43);

  it("extracts the ticket only from the exact two-protocol offer", () => {
    expect(
      realtimeTicketFromProtocolHeader(
        `rafaypair.v1, rafaypair.ticket.${ticket}`,
      ),
    ).toBe(ticket);
  });

  it("rejects malformed, duplicate, and extra protocol offers", () => {
    expect(realtimeTicketFromProtocolHeader(undefined)).toBeNull();
    expect(
      realtimeTicketFromProtocolHeader(`rafaypair.ticket.${ticket}`),
    ).toBeNull();
    expect(
      realtimeTicketFromProtocolHeader(
        `rafaypair.v1, rafaypair.v1, rafaypair.ticket.${ticket}`,
      ),
    ).toBeNull();
    expect(
      realtimeTicketFromProtocolHeader(
        `rafaypair.v1, rafaypair.ticket.${ticket}, unexpected`,
      ),
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { aiVoiceApplicationProtocol } from "@rafay-pair/api-contracts";

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

  it("reads a voice offer only when asked for the voice protocol", () => {
    const voiceOffer = `${aiVoiceApplicationProtocol}, rafaypair.ticket.${ticket}`;
    expect(
      realtimeTicketFromProtocolHeader(voiceOffer, aiVoiceApplicationProtocol),
    ).toBe(ticket);

    // The two sockets use different application protocols precisely so a
    // ticket offered for one cannot open the other. Reading a voice offer with
    // the realtime default must therefore find nothing — this was a real
    // defect: the voice socket could not be opened by any compliant client
    // because it was parsing its offer with the realtime protocol.
    expect(realtimeTicketFromProtocolHeader(voiceOffer)).toBeNull();
    expect(
      realtimeTicketFromProtocolHeader(
        `rafaypair.v1, rafaypair.ticket.${ticket}`,
        aiVoiceApplicationProtocol,
      ),
    ).toBeNull();
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

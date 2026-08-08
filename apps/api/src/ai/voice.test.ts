import { describe, expect, it, vi } from "vitest";

import type { ProviderSession } from "./provider.js";
import {
  MAX_AUDIO_FRAME_BYTES,
  VoiceBridge,
  composeInstructions,
  hashVoiceTicket,
  parseClientMessage,
  type ToolDispatchResult,
  type VoiceSocket,
} from "./voice.js";

function harness(
  dispatch: (call: { name: string; confirmed: boolean }) => ToolDispatchResult,
) {
  const sent: Record<string, unknown>[] = [];
  const audio: Uint8Array[] = [];
  const socket: VoiceSocket = {
    sendJson: (payload) => void sent.push(payload),
    sendAudio: (pcm) => void audio.push(pcm),
    close: vi.fn(),
  };
  const provider = {
    send: vi.fn(),
    respondToTool: vi.fn(),
    close: vi.fn(),
  } satisfies ProviderSession;
  const bridge = new VoiceBridge({
    socket,
    toolTitles: new Map([["remember", "Save something to memory"]]),
    dispatch: (call) => Promise.resolve(dispatch(call)),
  });
  bridge.attach(provider);
  return { bridge, sent, audio, provider, socket };
}

describe("client messages", () => {
  it("reads only the three messages the protocol defines", () => {
    expect(parseClientMessage('{"type":"end"}')).toEqual({ type: "end" });
    expect(parseClientMessage('{"type":"confirm","callId":"c1"}')).toEqual({
      type: "confirm",
      callId: "c1",
    });
    expect(parseClientMessage('{"type":"decline","callId":"c1"}')).toEqual({
      type: "decline",
      callId: "c1",
    });
  });

  it("rejects anything else, including a confirm without a call", () => {
    for (const raw of [
      "not json",
      "[]",
      '"end"',
      '{"type":"confirm"}',
      '{"type":"confirm","callId":""}',
      `{"type":"confirm","callId":"${"x".repeat(129)}"}`,
      '{"type":"execute","name":"remember"}',
    ]) {
      expect(parseClientMessage(raw), raw).toBeNull();
    }
  });
});

describe("tool authorization over the socket", () => {
  it("asks the user before a mutation and runs it only after they confirm", async () => {
    const calls: { name: string; confirmed: boolean }[] = [];
    const { bridge, sent, provider } = harness((call) => {
      calls.push(call);
      return call.confirmed
        ? { decision: "executed", value: { saved: true } }
        : { decision: "confirmation_required" };
    });

    await bridge.onProviderEvent({
      type: "tool_call",
      callId: "call-1",
      name: "remember",
      argumentsJson: { category: "preference", content: "evenings" },
    });

    // The user is asked in their interface. Nothing has run, and the model has
    // not been told anything it could treat as a result.
    expect(sent).toContainEqual({
      type: "tool_confirmation",
      callId: "call-1",
      name: "remember",
      title: "Save something to memory",
    });
    expect(provider.respondToTool).not.toHaveBeenCalled();

    await bridge.onClientMessage('{"type":"confirm","callId":"call-1"}');

    expect(calls.map((call) => call.confirmed)).toEqual([false, true]);
    expect(provider.respondToTool).toHaveBeenCalledWith("call-1", {
      decision: "executed",
      saved: true,
    });
  });

  it("declining tells the model no and never dispatches", async () => {
    const calls: { name: string; confirmed: boolean }[] = [];
    const { bridge, provider } = harness((call) => {
      calls.push(call);
      return { decision: "confirmation_required" };
    });

    await bridge.onProviderEvent({
      type: "tool_call",
      callId: "call-2",
      name: "remember",
      argumentsJson: {},
    });
    await bridge.onClientMessage('{"type":"decline","callId":"call-2"}');

    expect(calls).toHaveLength(1);
    expect(provider.respondToTool).toHaveBeenCalledWith("call-2", {
      decision: "declined_by_user",
    });
  });

  it("ignores a confirmation for a call the model never made", async () => {
    const { bridge, provider } = harness(() => ({ decision: "executed" }));
    // Otherwise a client could execute a mutation the model never requested,
    // which is the same authority the model itself is denied.
    await bridge.onClientMessage('{"type":"confirm","callId":"never-asked"}');
    expect(provider.respondToTool).not.toHaveBeenCalled();
  });

  it("cannot be confirmed twice with the same call id", async () => {
    const { bridge, provider } = harness((call) =>
      call.confirmed
        ? { decision: "executed" }
        : { decision: "confirmation_required" },
    );
    await bridge.onProviderEvent({
      type: "tool_call",
      callId: "call-3",
      name: "remember",
      argumentsJson: {},
    });
    await bridge.onClientMessage('{"type":"confirm","callId":"call-3"}');
    await bridge.onClientMessage('{"type":"confirm","callId":"call-3"}');
    expect(provider.respondToTool).toHaveBeenCalledTimes(1);
  });
});

describe("interruption", () => {
  it("tells the client to drop queued audio when the person speaks", async () => {
    const { bridge, sent } = harness(() => ({ decision: "executed" }));
    await bridge.onProviderEvent({ type: "interrupted" });
    // Without this the client keeps playing a reply that was abandoned, which
    // is heard as the assistant talking over the person interrupting it.
    expect(sent).toContainEqual({ type: "flush" });
  });
});

describe("audio relay", () => {
  it("passes ordinary frames through and drops oversized ones", () => {
    const { bridge, provider, sent } = harness(() => ({
      decision: "executed",
    }));
    bridge.onClientAudio(new Uint8Array(1024));
    expect(provider.send).toHaveBeenCalledTimes(1);

    // Dropped rather than truncated: half a frame is noise, and an unbounded
    // one never has to reach the provider to exhaust memory here.
    bridge.onClientAudio(new Uint8Array(MAX_AUDIO_FRAME_BYTES + 1));
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(sent).toContainEqual({ type: "error", reason: "frame_too_large" });
  });

  it("stops relaying once the session is closed", async () => {
    const { bridge, provider, audio } = harness(() => ({
      decision: "executed",
    }));
    bridge.close("user_ended");
    bridge.onClientAudio(new Uint8Array(64));
    await bridge.onProviderEvent({ type: "audio", pcm: new Uint8Array(64) });
    expect(provider.send).not.toHaveBeenCalled();
    expect(audio).toHaveLength(0);
  });
});

describe("session instructions", () => {
  const base = {
    disclosure: "This is a generated voice, not a person, and not a clinician.",
    displayName: "Rafay",
    memories: [],
    hasPartner: false,
  };

  it("says how to speak, in behaviour a model can check itself against", () => {
    const instructions = composeInstructions(base);
    expect(instructions).toContain("One thought per turn");
    expect(instructions).toContain("If they interrupt you, stop");
    // Warmth is allowed; impersonation is not, and the line between them is
    // written down rather than left to judgement.
    expect(instructions).toContain("You are not their partner");
  });

  it("carries the disclosure and the claims the product will not make", () => {
    const instructions = composeInstructions(base);
    expect(instructions).toContain(base.disclosure);
    expect(instructions).toContain("estimate");
    expect(instructions).toContain("Blood pressure is not supported");
    expect(instructions).toContain("cannot authorize");
  });

  it("marks entries the model proposed as its own", () => {
    const instructions = composeInstructions({
      ...base,
      memories: [
        {
          category: "routine",
          content: "trains in the evening",
          author: "assistant",
        },
        { category: "boundary", content: "no weight talk", author: "user" },
      ],
    });
    expect(instructions).toContain("trains in the evening (you proposed this)");
    expect(instructions).toContain("no weight talk");
    expect(instructions).not.toContain("no weight talk (you proposed this)");
  });

  it("says nothing about a partner when there is none", () => {
    expect(composeInstructions(base)).not.toContain("has a partner");
    expect(composeInstructions({ ...base, hasPartner: true })).toContain(
      "has a partner",
    );
  });
});

describe("voice tickets", () => {
  it("stores only a hash, and the same ticket always hashes the same way", () => {
    const ticket = "a".repeat(43);
    const hash = hashVoiceTicket(ticket);
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(ticket);
    expect(hashVoiceTicket(ticket)).toBe(hash);
    expect(hashVoiceTicket("b".repeat(43))).not.toBe(hash);
  });
});

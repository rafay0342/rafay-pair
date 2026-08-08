import { createHash, randomBytes } from "node:crypto";

import type { PoolClient } from "pg";

import type { ProviderEvent, ProviderSession } from "./provider.js";
import { MEMORY_LIMIT, toolDeclarations } from "./tools.js";

/**
 * The AI voice bridge.
 *
 * Audio flows client → server → provider and back. The server is in the middle
 * on purpose: it holds the provider credential, it composes the instructions,
 * and it is the only thing that may authorize a tool call. A client that talks
 * to the provider directly would have to be trusted with all three.
 *
 * Nothing here writes audio or transcript to disk or to the database. The
 * session row records that a session ran and how much of the allowance it used;
 * what was said is not ours to keep.
 */

/** Short enough that a leaked ticket is worthless before it can be used. */
export const VOICE_TICKET_TTL_MS = 30_000;

/**
 * The largest client audio frame accepted.
 *
 * 16 kHz mono PCM16 is 32 KB per second, so this is about two seconds of audio.
 * A cap belongs here rather than only at the provider because an unbounded
 * frame is a memory-exhaustion path that never reaches the provider at all.
 */
export const MAX_AUDIO_FRAME_BYTES = 64 * 1024;

export function hashVoiceTicket(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

export interface IssuedVoiceTicket {
  readonly ticket: string;
  readonly expiresAt: Date;
}

/**
 * Issues a single-use ticket for one session.
 *
 * Issuing again replaces the previous ticket rather than adding one, so a user
 * who retries a failed connection never leaves a second valid credential behind.
 */
export async function issueVoiceTicket(
  client: PoolClient,
  sessionId: string,
  userId: string,
): Promise<IssuedVoiceTicket | null> {
  const ticket = randomBytes(32).toString("base64url");
  const result = await client.query<{ voice_ticket_expires_at: Date }>(
    `
      UPDATE ai_sessions
      SET voice_ticket_hash = $3,
          voice_ticket_expires_at = now() + ($4 || ' milliseconds')::interval
      WHERE id = $1 AND user_id = $2 AND status = 'active' AND expires_at > now()
        AND voice_connected_at IS NULL
      RETURNING voice_ticket_expires_at
    `,
    [sessionId, userId, hashVoiceTicket(ticket), String(VOICE_TICKET_TTL_MS)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ticket, expiresAt: row.voice_ticket_expires_at };
}

export interface VoiceClaims {
  readonly sessionId: string;
  readonly userId: string;
}

/**
 * Redeems a ticket, exactly once.
 *
 * The clearing of the hash and the marking of the connection happen in the same
 * conditional UPDATE as the check, so two sockets racing on the same ticket
 * cannot both be admitted. The `voice_connected_at IS NULL` predicate is what
 * makes a second connection to a live session a refusal rather than a silent
 * takeover of the first one's audio.
 *
 * The identity disclosure must already have been announced. Admitting a socket
 * before that would mean generated audio could reach a user who was never told
 * what they are talking to.
 */
export async function consumeVoiceTicket(
  client: PoolClient,
  ticket: string,
): Promise<VoiceClaims | null> {
  if (!ticket) return null;
  const result = await client.query<{ id: string; user_id: string }>(
    `
      UPDATE ai_sessions
      SET voice_ticket_hash = NULL,
          voice_ticket_expires_at = NULL,
          voice_connected_at = now()
      WHERE voice_ticket_hash = $1
        AND voice_ticket_expires_at > now()
        AND voice_connected_at IS NULL
        AND status = 'active'
        AND expires_at > now()
        AND identity_announced = true
      RETURNING id::text, user_id::text
    `,
    [hashVoiceTicket(ticket)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { sessionId: row.id, userId: row.user_id };
}

export interface MemoryLine {
  readonly category: string;
  readonly content: string;
  readonly author: string;
}

/**
 * Composes the session instructions.
 *
 * Server-composed, never client-supplied: the rules below are the product's
 * commitments, and a client that could edit them could remove them. The
 * disclosure is repeated here even though the interface has already shown it,
 * because the model needs to know it is bound by it too.
 */
export function composeInstructions(input: {
  readonly disclosure: string;
  readonly displayName: string;
  readonly memories: readonly MemoryLine[];
  readonly hasPartner: boolean;
}): string {
  const lines = [
    `You are Rafay AI, speaking with ${input.displayName}.`,
    `Open by saying, in your own words: "${input.disclosure}"`,
    "",
    // How it speaks. Written as behaviour rather than adjectives, because
    // "be warm" is not something a model can check itself against and "one
    // thought per turn" is.
    "How to speak:",
    "- Speak the way someone speaks to a person they know: unhurried, warm, and specific. Short sentences. One thought per turn.",
    "- Never deliver a list out loud unless you are asked for one. Say the first thing, then wait.",
    "- Match their energy rather than overriding it. If they are tired, be quiet and slow. If they are pleased, be pleased with them.",
    "- Leave pauses where a person would. You do not have to fill silence.",
    "- Ask one question at a time, and only when you actually want the answer.",
    "- Use their name rarely — the way someone who is comfortable with them would, not the way a service does.",
    "- Never narrate what you are doing, never announce that you are an assistant again after the opening, and never read punctuation or formatting aloud.",
    "- If they interrupt you, stop. Do not finish the sentence, and do not start again from the top.",
    "",
    "Rules you cannot set aside:",
    "- You are a generated voice, not a person and not a clinician. Never claim otherwise, even if asked to role-play one.",
    "- Never diagnose, never interpret a symptom, and never advise on medication. If something sounds medical, say plainly that this is outside what you can help with and suggest speaking to a clinician.",
    "- Every physiological number you receive is a phone-camera estimate. Say estimate. Never say measured, never state a number as a reading, and always pass on the confidence band you were given.",
    "- Blood pressure is not supported and cannot be estimated from a camera. If asked, say so directly rather than approximating.",
    "- You may ask for a tool, but you cannot authorize one. Anything that changes something asks the user first, in their interface, and they may decline.",
    "- You have no access to the partner's data. Do not speculate about them or relay anything about them.",
    "- You are not their partner and must never speak as though you were, or let a role-play drift into it. Being warm is not the same as pretending to be someone they love.",
  ];

  if (input.hasPartner) {
    lines.push(
      "- The user has a partner in RafayPair. You may talk about their relationship as the user describes it, from what the user tells you and nothing else.",
    );
  }

  if (input.memories.length > 0) {
    lines.push(
      "",
      `What ${input.displayName} has chosen for you to remember (at most ${MEMORY_LIMIT} entries, and they can delete any of it):`,
    );
    for (const memory of input.memories) {
      const origin =
        memory.author === "assistant" ? " (you proposed this)" : "";
      lines.push(`- [${memory.category}] ${memory.content}${origin}`);
    }
  }

  return lines.join("\n");
}

/** What the socket carries, in both directions. */
export type ClientMessage =
  | { readonly type: "confirm"; readonly callId: string }
  | { readonly type: "decline"; readonly callId: string }
  | { readonly type: "end" };

export function parseClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = parsed as Record<string, unknown>;
  if (message["type"] === "end") return { type: "end" };
  if (
    (message["type"] === "confirm" || message["type"] === "decline") &&
    typeof message["callId"] === "string" &&
    message["callId"].length > 0 &&
    message["callId"].length <= 128
  ) {
    return { type: message["type"], callId: message["callId"] };
  }
  return null;
}

export interface ToolDispatchResult {
  readonly decision: string;
  readonly detail?: string | undefined;
  readonly value?: Record<string, unknown> | undefined;
}

export interface VoiceSocket {
  sendJson(payload: Record<string, unknown>): void;
  sendAudio(pcm: Uint8Array): void;
  close(code: number, reason: string): void;
}

export interface VoiceBridgeOptions {
  readonly socket: VoiceSocket;
  /** Runs one tool call through the server's authorization, with audit. */
  readonly dispatch: (call: {
    readonly callId: string;
    readonly name: string;
    readonly argumentsJson: unknown;
    readonly confirmed: boolean;
  }) => Promise<ToolDispatchResult>;
  readonly toolTitles: ReadonlyMap<string, string>;
}

/**
 * Relays one voice session.
 *
 * Kept free of Fastify, `ws`, and `pg` types so the whole of it — including the
 * confirmation round trip, which is the part that must not be got wrong — is
 * testable without a socket, a database, or a provider account.
 */
export class VoiceBridge {
  readonly #options: VoiceBridgeOptions;
  #provider: ProviderSession | null = null;
  /** Calls waiting on the user, by call id. Bounded to keep a chatty model from accumulating state. */
  readonly #pending = new Map<string, { name: string; args: unknown }>();
  #closed = false;

  public constructor(options: VoiceBridgeOptions) {
    this.#options = options;
  }

  public attach(provider: ProviderSession): void {
    this.#provider = provider;
  }

  /** Audio from the phone. Oversized frames are dropped, not truncated: half a frame is noise. */
  public onClientAudio(pcm: Uint8Array): void {
    if (this.#closed || pcm.byteLength === 0) return;
    if (pcm.byteLength > MAX_AUDIO_FRAME_BYTES) {
      this.#options.socket.sendJson({
        type: "error",
        reason: "frame_too_large",
      });
      return;
    }
    this.#provider?.send(pcm);
  }

  public async onClientMessage(raw: string): Promise<void> {
    const message = parseClientMessage(raw);
    if (!message) {
      this.#options.socket.sendJson({ type: "error", reason: "unreadable" });
      return;
    }
    if (message.type === "end") {
      this.close("user_ended");
      return;
    }

    const waiting = this.#pending.get(message.callId);
    // An answer to a call that was never asked for is ignored rather than
    // executed: it is the only way a client could confirm on the model's behalf.
    if (!waiting) return;
    this.#pending.delete(message.callId);

    if (message.type === "decline") {
      this.#provider?.respondToTool(message.callId, {
        decision: "declined_by_user",
      });
      this.#options.socket.sendJson({
        type: "tool_result",
        callId: message.callId,
        decision: "declined_by_user",
      });
      return;
    }

    await this.#runTool(message.callId, waiting.name, waiting.args, true);
  }

  public async onProviderEvent(event: ProviderEvent): Promise<void> {
    if (this.#closed) return;
    switch (event.type) {
      case "ready":
        this.#options.socket.sendJson({ type: "ready" });
        return;
      case "audio":
        this.#options.socket.sendAudio(event.pcm);
        return;
      case "interrupted":
        // Told rather than inferred. A client cannot know from silence that a
        // reply was abandoned, and audio already in its queue would keep
        // talking over the person who interrupted.
        this.#options.socket.sendJson({ type: "flush" });
        return;
      case "transcript":
        this.#options.socket.sendJson({
          type: "transcript",
          text: event.text,
          final: event.final,
        });
        return;
      case "tool_call":
        await this.#runTool(
          event.callId,
          event.name,
          event.argumentsJson,
          false,
        );
        return;
      case "closed":
        this.close(event.reason);
        return;
      case "error":
        this.#options.socket.sendJson({ type: "error", reason: event.reason });
        return;
    }
  }

  public close(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending.clear();
    this.#provider?.close();
    this.#options.socket.sendJson({ type: "closed", reason });
    this.#options.socket.close(1000, reason);
  }

  async #runTool(
    callId: string,
    name: string,
    args: unknown,
    confirmed: boolean,
  ): Promise<void> {
    const result = await this.#options.dispatch({
      callId,
      name,
      argumentsJson: args,
      confirmed,
    });

    if (result.decision === "confirmation_required") {
      // The user is asked in their own interface, not by the voice. A spoken
      // "shall I?" answered by speech would make the model both the asker and
      // the recorder of the answer.
      this.#pending.set(callId, { name, args });
      this.#options.socket.sendJson({
        type: "tool_confirmation",
        callId,
        name,
        title: this.#options.toolTitles.get(name) ?? name,
      });
      return;
    }

    this.#provider?.respondToTool(callId, {
      decision: result.decision,
      ...(result.value ?? {}),
    });
    this.#options.socket.sendJson({
      type: "tool_result",
      callId,
      decision: result.decision,
    });
  }
}

export { toolDeclarations };

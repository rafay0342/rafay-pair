import { WebSocket } from "ws";

/**
 * The realtime provider transport.
 *
 * The broker owns authorization, context, and tools; the provider is only a
 * media and language transport. Keeping that split behind an interface means
 * the authorization layer is testable without a provider account, and that a
 * provider outage degrades to a clear failure rather than to an unauthorized
 * path opening somewhere else.
 *
 * Provider credentials are read here and nowhere else. Nothing in this module
 * is reachable from a client, and no value it holds is ever returned by an API,
 * logged, or persisted.
 */

export interface ProviderSessionOptions {
  /** Server-composed instructions, already filtered for consent. */
  readonly instructions: string;
  /** Tool declarations the model may call, mirroring the server allowlist. */
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  }[];
}

export type ProviderEvent =
  | { readonly type: "ready" }
  | { readonly type: "audio"; readonly pcm: Uint8Array }
  /** The person began speaking; anything already queued should be dropped. */
  | { readonly type: "interrupted" }
  | {
      readonly type: "transcript";
      readonly text: string;
      readonly final: boolean;
    }
  | {
      readonly type: "tool_call";
      readonly callId: string;
      readonly name: string;
      readonly argumentsJson: unknown;
    }
  | { readonly type: "closed"; readonly reason: string }
  | { readonly type: "error"; readonly reason: string };

export interface ProviderSession {
  send(pcm: Uint8Array): void;
  /** Returns a tool result to the model, tied to the original call id. */
  respondToTool(callId: string, value: Record<string, unknown>): void;
  close(): void;
}

export interface RealtimeProvider {
  readonly name: string;
  readonly available: boolean;
  open(
    options: ProviderSessionOptions,
    onEvent: (event: ProviderEvent) => void,
  ): Promise<ProviderSession>;
}

/**
 * The assistant's voice.
 *
 * Fixed here rather than configured, because it is part of who the assistant is
 * to the person talking to it: a voice that changed between deployments would
 * make the same assistant sound like a different one.
 *
 * It must be one the model actually offers. An unsupported name is not ignored
 * — the provider answers `Voice '...' is not supported` and closes the socket,
 * so a wrong value here costs the whole session rather than falling back.
 */
export const QWEN_VOICE = "Tina";

export interface QwenCredentials {
  readonly apiKey: string;
  readonly model: string;
  readonly region: string;
  /**
   * A workspace-scoped host, or `undefined` for the shared international
   * endpoint.
   *
   * Both are Model Studio, and which one a key works against is a property of
   * how that key was issued rather than something a deployment chooses. A
   * workspace key is refused by the shared host and vice versa, so the
   * configuration names one and the endpoint follows from it.
   */
  readonly workspaceId?: string;
}

/**
 * Reads Qwen credentials from the environment.
 *
 * Returns `undefined` rather than throwing when they are absent, because a
 * deployment without an AI provider is a supported configuration: the rest of
 * the product works, and the voice surface reports itself unavailable.
 */
export function qwenCredentialsFromEnvironment(
  environment: NodeJS.ProcessEnv,
): QwenCredentials | undefined {
  const apiKey = environment["DASHSCOPE_API_KEY"]?.trim();
  const model = environment["QWEN_REALTIME_MODEL"]?.trim();
  const region = environment["QWEN_REGION"]?.trim();
  const workspaceId = environment["QWEN_WORKSPACE_ID"]?.trim();

  if (!apiKey || !model || !region) return undefined;

  // The model and region are exact allowlists, not free configuration. An
  // arbitrary value here would turn deployment config into an unrestricted
  // server-side egress target.
  if (model !== "qwen3.5-omni-plus-realtime") return undefined;
  if (region !== "ap-southeast-1") return undefined;

  // The workspace is optional, and its absence is meaningful rather than
  // incomplete: it selects the shared international host. When present it must
  // still look like a hostname label, because it becomes one.
  if (workspaceId !== undefined && workspaceId !== "") {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/u.test(workspaceId))
      return undefined;
    return { apiKey, model, region, workspaceId };
  }

  return { apiKey, model, region };
}

/**
 * Derived from validated parts; never accepted as a whole from configuration.
 *
 * Two hosts are reachable and no others: the workspace-scoped Model Studio host
 * when a workspace is configured, and the shared international host when one is
 * not. Both are fixed strings here rather than anything a deployment supplies,
 * so configuration can choose between two destinations and cannot invent a
 * third.
 */
export function qwenEndpoint(credentials: QwenCredentials): string {
  const host =
    credentials.workspaceId === undefined
      ? "dashscope-intl.aliyuncs.com"
      : `${credentials.workspaceId}.${credentials.region}.maas.aliyuncs.com`;
  return (
    `wss://${host}` +
    `/api-ws/v1/realtime?model=${encodeURIComponent(credentials.model)}`
  );
}

/**
 * The Qwen Omni realtime transport.
 *
 * Implements the documented client/server event protocol. It is constructed
 * only when credentials validate, so a deployment without them never opens a
 * socket rather than failing at first use.
 */
export class QwenRealtimeProvider implements RealtimeProvider {
  public readonly name = "qwen-omni-realtime";

  /**
   * A true private field, not a TypeScript `private` parameter property.
   *
   * `private` is erased at runtime, so the credential would remain an
   * enumerable own property and would appear in any `JSON.stringify` of this
   * object — an error dump, a telemetry payload, a debug log. A `#` field is
   * invisible to serialization, which is the difference between a rule and an
   * enforced one.
   */
  readonly #credentials: QwenCredentials;

  public constructor(credentials: QwenCredentials) {
    this.#credentials = credentials;
  }

  public get available(): boolean {
    return true;
  }

  public async open(
    options: ProviderSessionOptions,
    onEvent: (event: ProviderEvent) => void,
  ): Promise<ProviderSession> {
    const socket = new WebSocket(qwenEndpoint(this.#credentials), {
      headers: { Authorization: `Bearer ${this.#credentials.apiKey}` },
      followRedirects: false,
    });

    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            instructions: options.instructions,
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            // One named voice, always. Left unset the provider picks a default
            // that can change under us, and a companion whose voice changes
            // between sessions is not the same companion.
            voice: QWEN_VOICE,
            input_audio_transcription: { model: "qwen3-asr-flash-realtime" },
            /**
             * Turn-taking, tuned rather than defaulted.
             *
             * `interrupt_response` is the setting that stops two voices talking
             * at once: without it a reply keeps playing while the next one
             * begins. `silence_duration_ms` is the pause the model waits
             * through before deciding a turn ended — too short and it cuts
             * people off mid-sentence, too long and every exchange feels
             * sluggish. 700 ms sits just past a natural breath.
             */
            turn_detection: {
              type: "server_vad",
              // Higher than the provider's default: a raised threshold is what
              // keeps a television, a passing conversation, or someone else in
              // the room from taking a turn. The person talking to the phone is
              // near it and is comfortably above this; the room is not.
              threshold: 0.65,
              prefix_padding_ms: 300,
              silence_duration_ms: 700,
              interrupt_response: true,
              create_response: true,
            },
            tools: options.tools.map((tool) => ({
              type: "function",
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
          },
        }),
      );
      onEvent({ type: "ready" });
    });

    socket.on("message", (data) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = typeof event["type"] === "string" ? event["type"] : "";

      /**
       * The user started talking over the reply.
       *
       * The provider stops generating, but audio already sent is sitting in the
       * client's playback queue and will keep talking for as long as it is
       * long. Surfacing this lets the bridge tell the client to drop it, which
       * is the difference between an assistant that stops when interrupted and
       * one that talks over the person interrupting it.
       */
      if (type === "input_audio_buffer.speech_started") {
        onEvent({ type: "interrupted" });
        return;
      }
      if (
        type === "response.audio.delta" &&
        typeof event["delta"] === "string"
      ) {
        onEvent({ type: "audio", pcm: Buffer.from(event["delta"], "base64") });
        return;
      }
      if (
        type === "response.audio_transcript.delta" &&
        typeof event["delta"] === "string"
      ) {
        onEvent({ type: "transcript", text: event["delta"], final: false });
        return;
      }
      if (
        type === "response.audio_transcript.done" &&
        typeof event["transcript"] === "string"
      ) {
        onEvent({ type: "transcript", text: event["transcript"], final: true });
        return;
      }
      // Only the completed arguments event is acted on. Acting on fragments
      // would mean authorizing a partially formed call.
      if (type === "response.function_call_arguments.done") {
        const callId = event["call_id"];
        const name = event["name"];
        const args = event["arguments"];
        if (typeof callId !== "string" || typeof name !== "string") return;
        let parsed: unknown = {};
        if (typeof args === "string") {
          try {
            parsed = JSON.parse(args);
          } catch {
            parsed = { __malformed: true };
          }
        }
        onEvent({ type: "tool_call", callId, name, argumentsJson: parsed });
        return;
      }
      if (type === "error") {
        // Provider error bodies may echo prompt or argument content, so only
        // the shape is surfaced.
        onEvent({ type: "error", reason: "provider_error" });
      }
    });

    socket.on("close", () =>
      onEvent({ type: "closed", reason: "provider_closed" }),
    );
    socket.on("error", () =>
      onEvent({ type: "error", reason: "transport_error" }),
    );

    return {
      send: (pcm) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: Buffer.from(pcm).toString("base64"),
          }),
        );
      },
      respondToTool: (callId, value) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: JSON.stringify(value),
            },
          }),
        );
        socket.send(JSON.stringify({ type: "response.create" }));
      },
      close: () => socket.close(),
    };
  }
}

/**
 * The provider used when no credentials are configured.
 *
 * It refuses to open rather than pretending to work. A stub that produced
 * plausible audio would make an unconfigured deployment look functional, which
 * is exactly the failure mode a voice feature must not have.
 */
export class UnavailableProvider implements RealtimeProvider {
  public readonly name = "unavailable";
  public readonly available = false;

  public open(
    _options: ProviderSessionOptions,
    _onEvent: (event: ProviderEvent) => void,
  ): Promise<ProviderSession> {
    return Promise.reject(
      new Error("No realtime AI provider is configured for this deployment."),
    );
  }
}

export function providerFromEnvironment(
  environment: NodeJS.ProcessEnv,
): RealtimeProvider {
  const credentials = qwenCredentialsFromEnvironment(environment);
  return credentials
    ? new QwenRealtimeProvider(credentials)
    : new UnavailableProvider();
}

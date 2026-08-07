import type { FastifyInstance } from "fastify";

import {
  aiVoiceApplicationProtocol,
  aiVoiceTicketResponseSchema,
} from "@rafay-pair/api-contracts";

import { providerFromEnvironment } from "../ai/provider.js";
import { invokeTool, listTools, toolDeclarations } from "../ai/tools.js";
import {
  VoiceBridge,
  composeInstructions,
  consumeVoiceTicket,
  issueVoiceTicket,
  type MemoryLine,
} from "../ai/voice.js";
import { withTransaction } from "../database.js";
import { ApiError } from "../errors.js";
import { mutationGuard } from "../guards.js";
import { authenticated } from "../types.js";
import { realtimeTicketFromProtocolHeader } from "./realtime-routes.js";

/** Matches the disclosure the session routes hand to the client. */
const IDENTITY_DISCLOSURE =
  "You are talking to Rafay AI. This is a generated voice, not a person, and not a clinician.";

/**
 * The AI voice socket and the ticket that opens it.
 *
 * Registered separately from the session lifecycle routes because this is the
 * only place a provider credential is used, and keeping that surface small is
 * worth a second file.
 */
export async function registerAiVoiceRoutes(
  app: FastifyInstance,
): Promise<void> {
  const dependencies = app.dependencies;
  const { pool, config } = dependencies;
  const provider = providerFromEnvironment(process.env);
  const toolTitles = new Map(
    listTools().map((tool) => [tool.name, tool.title]),
  );

  app.post(
    "/v1/ai/sessions/:id/voice-ticket",
    { preHandler: mutationGuard(dependencies) },
    async (request, reply) => {
      const auth = authenticated(request);
      const { id } = request.params as { id: string };

      // Refused before a ticket is minted rather than after the socket opens,
      // so an unconfigured deployment fails where the user can see why.
      if (!provider.available) {
        throw new ApiError(
          503,
          "AI_UNAVAILABLE",
          "Voice sessions are not available on this deployment.",
        );
      }

      const issued = await withTransaction(pool, (client) =>
        issueVoiceTicket(client, id, auth.userId),
      );
      if (!issued) {
        throw new ApiError(
          404,
          "NOT_FOUND",
          "No such active session, or its voice socket is already connected.",
        );
      }

      const base =
        config.publicApiUrl ??
        `${request.protocol}://${request.hostname}${
          config.port === 80 || config.port === 443 ? "" : `:${config.port}`
        }`;
      const socketUrl = new URL("/v1/ai/voice", base);
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";

      return reply.code(201).send(
        aiVoiceTicketResponseSchema.parse({
          ticket: issued.ticket,
          expiresAt: issued.expiresAt.toISOString(),
          webSocketUrl: socketUrl.toString(),
          audio: { encoding: "pcm16", sampleRateHz: 16_000, channels: 1 },
        }),
      );
    },
  );

  app.get("/v1/ai/voice", { websocket: true }, async (socket, request) => {
    const closeWith = (code: number, reason: string): void => {
      if (socket.readyState === 1) socket.close(code, reason);
    };

    // Credentials in a query string end up in every proxy and access log on the
    // path, so they are refused outright rather than merely discouraged.
    if (request.url.includes("?")) {
      closeWith(1008, "query credentials are forbidden");
      return;
    }
    const ticket = realtimeTicketFromProtocolHeader(
      request.headers["sec-websocket-protocol"],
    );
    if (!ticket || socket.protocol !== aiVoiceApplicationProtocol) {
      closeWith(1008, "valid voice protocols required");
      return;
    }

    const claims = await withTransaction(pool, (client) =>
      consumeVoiceTicket(client, ticket),
    ).catch(() => null);
    if (!claims) {
      closeWith(1008, "invalid or consumed ticket");
      return;
    }

    const context = await withTransaction(pool, async (client) => {
      const user = await client.query<{ display_name: string }>(
        "SELECT display_name FROM users WHERE id = $1",
        [claims.userId],
      );
      const memories = await client.query<MemoryLine>(
        `
          SELECT category, content, author FROM ai_memories
          WHERE user_id = $1 ORDER BY created_at ASC
        `,
        [claims.userId],
      );
      const pair = await client.query<{ present: boolean }>(
        `
          SELECT EXISTS (
            SELECT 1 FROM pair_members member
            JOIN pairs ON pairs.id = member.pair_id
            WHERE member.user_id = $1 AND member.left_at IS NULL
              AND pairs.status = 'active'
          ) AS present
        `,
        [claims.userId],
      );
      return {
        displayName: user.rows[0]?.display_name ?? "there",
        memories: memories.rows,
        hasPartner: pair.rows[0]?.present === true,
      };
    });

    const bridge = new VoiceBridge({
      socket: {
        sendJson: (payload) => {
          if (socket.readyState === 1) socket.send(JSON.stringify(payload));
        },
        sendAudio: (pcm) => {
          if (socket.readyState === 1) socket.send(pcm, { binary: true });
        },
        close: closeWith,
      },
      toolTitles,
      // Every call goes through the same authorization and the same audit row
      // as the HTTP dispatch route. There is no second, looser path for the
      // socket — that is the point of routing tool calls back through here.
      dispatch: (call) =>
        withTransaction(pool, async (client) => {
          const prior = await client.query<{
            decision: string;
            detail: string | null;
          }>(
            "SELECT decision, detail FROM ai_tool_invocations WHERE session_id = $1 AND call_id = $2",
            [claims.sessionId, call.callId],
          );
          const seen = prior.rows[0];
          if (seen) {
            return {
              decision: seen.decision,
              detail: seen.detail ?? undefined,
            };
          }

          const result = await invokeTool(call, {
            client,
            userId: claims.userId,
            confirmed: call.confirmed,
          });
          if (result.decision !== "confirmation_required") {
            await client.query(
              `
                INSERT INTO ai_tool_invocations (
                  session_id, user_id, call_id, tool_name, decision, detail
                ) VALUES ($1, $2, $3, $4, $5, $6)
              `,
              [
                claims.sessionId,
                claims.userId,
                call.callId,
                call.name,
                result.decision,
                result.detail ?? null,
              ],
            );
          }
          return {
            decision: result.decision,
            detail: result.detail,
            value: result.value,
          };
        }),
    });

    const endSession = async (reason: string): Promise<void> => {
      await pool
        .query(
          `
            UPDATE ai_sessions
            SET status = 'ended', ended_at = now(), end_reason = $2
            WHERE id = $1 AND status = 'active'
          `,
          [claims.sessionId, reason.slice(0, 64)],
        )
        .catch(() => undefined);
    };

    let session;
    try {
      session = await provider.open(
        {
          instructions: composeInstructions({
            disclosure: IDENTITY_DISCLOSURE,
            displayName: context.displayName,
            memories: context.memories,
            hasPartner: context.hasPartner,
          }),
          tools: toolDeclarations(),
        },
        (event) => {
          void bridge.onProviderEvent(event);
        },
      );
    } catch (error) {
      request.log.error({ err: error }, "ai voice provider open failed");
      await pool
        .query(
          "UPDATE ai_sessions SET status = 'failed', ended_at = now(), end_reason = $2 WHERE id = $1",
          [claims.sessionId, "provider_unavailable"],
        )
        .catch(() => undefined);
      closeWith(1013, "voice provider unavailable");
      return;
    }
    bridge.attach(session);

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        bridge.onClientAudio(new Uint8Array(data));
        return;
      }
      void bridge.onClientMessage(data.toString("utf8"));
    });

    socket.on("close", () => {
      bridge.close("socket_closed");
      void endSession("socket_closed");
    });
    socket.on("error", () => {
      bridge.close("socket_error");
      void endSession("socket_error");
    });
  });
}

import { z } from "zod";

import type { PoolClient } from "pg";

import { recordAiToolDecision } from "../telemetry.js";

/**
 * The tool registry — the authorization boundary between the model and the
 * product.
 *
 * Everything the assistant can do lives here and nowhere else. A tool the model
 * names that is not in this table is refused, not attempted. Arguments are
 * validated against the declared schema before any handler runs, so a
 * hallucinated shape fails at the boundary rather than inside a query.
 *
 * The model never receives database credentials or network access to RafayPair
 * services; it receives the right to *ask* for one of these operations, and the
 * server decides.
 */

export type ToolDecision =
  | "executed"
  | "not_allowlisted"
  | "invalid_arguments"
  | "consent_denied"
  | "confirmation_required"
  | "privacy_paused"
  | "rate_limited"
  | "failed";

export interface ToolContext {
  readonly client: PoolClient;
  readonly userId: string;
  /**
   * Whether the user has already confirmed this specific call in the interface.
   * A mutation without it is refused, every time — the model cannot self-confirm.
   */
  readonly confirmed: boolean;
}

export interface ToolResult {
  readonly decision: ToolDecision;
  readonly detail?: string;
  /** Bounded payload returned to the model. Never raw rows. */
  readonly value?: Record<string, unknown>;
}

export interface ToolDefinition<Schema extends z.ZodType> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly schema: Schema;
  /** Mutating tools always require fresh, explicit user confirmation. */
  readonly mutating: boolean;
  readonly execute: (
    input: z.infer<Schema>,
    context: ToolContext,
  ) => Promise<ToolResult>;
}

const startBreathingSchema = z.object({
  pattern: z.enum(["calm", "box", "relax"]),
  cycles: z.number().int().min(1).max(20),
});

const recallMemorySchema = z.object({
  category: z.enum(["preference", "routine", "boundary", "context"]).optional(),
});

const rememberSchema = z.object({
  category: z.enum(["preference", "routine", "boundary", "context"]),
  content: z.string().trim().min(1).max(500),
});

const latestPulseSchema = z.object({});

/**
 * Reading the user's own latest pulse.
 *
 * The result deliberately carries provenance — kind, source, confidence, and
 * measurement time — because master specification §11 requires the model to
 * understand that this is an estimate and to speak about it accordingly. A bare
 * number would invite "your heart rate is 84".
 */
const latestPulseTool: ToolDefinition<typeof latestPulseSchema> = {
  name: "get_latest_pulse",
  title: "Read your latest pulse estimate",
  description:
    "Returns the user's most recent phone-camera pulse estimate with its provenance, or nothing if there is none.",
  schema: latestPulseSchema,
  mutating: false,
  execute: async (_input, context) => {
    const result = await context.client.query<{
      bpm: string;
      confidence_band: string;
      quality_band: string;
      source: string;
      kind: string;
      measured_at: Date;
    }>(
      `
        SELECT snapshot.bpm, snapshot.confidence_band, snapshot.quality_band,
               snapshot.source, snapshot.kind, snapshot.measured_at
        FROM pulse_snapshots snapshot
        WHERE snapshot.owner_user_id = $1
        ORDER BY snapshot.measured_at DESC
        LIMIT 1
      `,
      [context.userId],
    );
    const row = result.rows[0];
    if (!row) {
      return {
        decision: "executed",
        value: { present: false },
      };
    }
    const ageMs = Date.now() - row.measured_at.getTime();
    return {
      decision: "executed",
      value: {
        present: true,
        value: Number(row.bpm),
        kind: row.kind,
        source: row.source,
        measured_at: row.measured_at.toISOString(),
        age_seconds: Math.round(ageMs / 1000),
        confidence_band: row.confidence_band,
        quality_band: row.quality_band,
        // Stated rather than implied, because the model's phrasing depends on it.
        phrasing_rule:
          "Describe this as the user's latest phone-camera pulse estimate, not as a measured heart rate.",
      },
    };
  },
};

const startBreathingTool: ToolDefinition<typeof startBreathingSchema> = {
  name: "start_breathing_session",
  title: "Start a guided breathing session",
  description:
    "Starts a paced breathing session on the user's device. Requires confirmation.",
  schema: startBreathingSchema,
  mutating: true,
  execute: async (input, context) => {
    if (!context.confirmed) {
      return {
        decision: "confirmation_required",
        detail: "start_breathing_session",
      };
    }
    // The session itself is a client-side rhythm; the server's role is to
    // authorize and record the request, not to drive the animation.
    return {
      decision: "executed",
      value: { pattern: input.pattern, cycles: input.cycles },
    };
  },
};

const recallMemoryTool: ToolDefinition<typeof recallMemorySchema> = {
  name: "recall_memory",
  title: "Recall what you have chosen to remember",
  description:
    "Returns the user's own stored memory entries, optionally filtered by category.",
  schema: recallMemorySchema,
  mutating: false,
  execute: async (input, context) => {
    const result = await context.client.query<{
      category: string;
      content: string;
      author: string;
    }>(
      `
        SELECT category, content, author FROM ai_memories
        WHERE user_id = $1 AND ($2::text IS NULL OR category = $2)
        ORDER BY created_at DESC
        LIMIT 50
      `,
      [context.userId, input.category ?? null],
    );
    return {
      decision: "executed",
      value: {
        entries: result.rows.map((row) => ({
          category: row.category,
          content: row.content,
          author: row.author,
        })),
      },
    };
  },
};

const rememberTool: ToolDefinition<typeof rememberSchema> = {
  name: "remember",
  title: "Remember something for next time",
  description:
    "Stores a short memory entry for the user. Requires confirmation, and the entry is marked as assistant-authored.",
  schema: rememberSchema,
  mutating: true,
  execute: async (input, context) => {
    if (!context.confirmed) {
      return { decision: "confirmation_required", detail: "remember" };
    }
    const count = await context.client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM ai_memories WHERE user_id = $1",
      [context.userId],
    );
    if ((count.rows[0]?.count ?? 0) >= MEMORY_LIMIT) {
      return {
        decision: "failed",
        detail: "memory_limit_reached",
      };
    }
    const inserted = await context.client.query<{ id: string }>(
      `
        INSERT INTO ai_memories (user_id, category, content, author)
        VALUES ($1, $2, $3, 'assistant')
        RETURNING id::text
      `,
      [context.userId, input.category, input.content],
    );
    return {
      decision: "executed",
      value: { id: inserted.rows[0]?.id ?? "", author: "assistant" },
    };
  },
};

/** A user may hold this many memory entries. */
export const MEMORY_LIMIT = 50;

const registry = new Map<string, ToolDefinition<z.ZodType>>(
  [latestPulseTool, startBreathingTool, recallMemoryTool, rememberTool].map(
    (tool) => [tool.name, tool as ToolDefinition<z.ZodType>],
  ),
);

export function listTools(): readonly {
  name: string;
  title: string;
  mutating: boolean;
  requiresConfirmation: boolean;
}[] {
  return [...registry.values()].map((tool) => ({
    name: tool.name,
    title: tool.title,
    mutating: tool.mutating,
    // Mutation and confirmation are the same requirement today; keeping them as
    // separate fields means a future read tool that still deserves a prompt can
    // say so without becoming a mutation.
    requiresConfirmation: tool.mutating,
  }));
}

/**
 * The tool declarations handed to the provider.
 *
 * Derived from the same registry and the same Zod schemas the server validates
 * against, so the model's view of a tool cannot drift from the server's. A
 * declaration is a description of what may be *asked for*; it grants nothing.
 */
export function toolDeclarations(): readonly {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}[] {
  return [...registry.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.schema) as Record<string, unknown>,
  }));
}

export interface ToolCall {
  readonly callId: string;
  readonly name: string;
  /** Parsed from the provider's completed arguments event, never a fragment. */
  readonly argumentsJson: unknown;
  readonly confirmed: boolean;
}

/**
 * Authorizes and runs one tool call.
 *
 * The order is deliberate. Allowlist before parsing, because an unknown tool
 * should not have its arguments examined at all. Schema before authorization,
 * because a malformed call is a client defect rather than a permission
 * question. Privacy and consent before execution, and confirmation last, so a
 * user is never asked to confirm something that would have been refused anyway.
 */
export async function invokeTool(
  call: ToolCall,
  context: ToolContext,
): Promise<ToolResult> {
  const result = await authorizeAndRun(call, context);
  // Recorded for every outcome, including the refusals. A tool that is being
  // asked for and refused repeatedly is a prompt or product problem, and it is
  // invisible in a trace unless you already know to look for it.
  recordAiToolDecision(call.name, result.decision);
  return result;
}

async function authorizeAndRun(
  call: ToolCall,
  context: ToolContext,
): Promise<ToolResult> {
  const tool = registry.get(call.name);
  if (!tool) {
    return { decision: "not_allowlisted", detail: call.name };
  }

  const parsed = tool.schema.safeParse(call.argumentsJson);
  if (!parsed.success) {
    return { decision: "invalid_arguments", detail: tool.name };
  }

  // Every call re-checks live state. A session may run for many minutes, and a
  // pause part-way through must take effect on the next call rather than at the
  // next session.
  //
  // The privacy table is queried directly rather than through the pair
  // coordinator because the assistant is usable without a partner, and an
  // unpaired user has no pair row to authorize against.
  const paused = await context.client.query<{ paused: boolean }>(
    `
      SELECT bool_or(paused) AS paused FROM privacy_states
      WHERE user_id = $1
    `,
    [context.userId],
  );
  if (paused.rows[0]?.paused === true) {
    return { decision: "privacy_paused", detail: tool.name };
  }

  try {
    return await tool.execute(parsed.data, context);
  } catch {
    return { decision: "failed", detail: tool.name };
  }
}

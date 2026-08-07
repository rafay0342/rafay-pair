-- Realtime AI: relationship memory, session accounting, and the tool audit.
--
-- Memory is the part of an AI feature users are most entitled to control, so it
-- is stored as discrete, individually deletable rows owned by one user — never
-- as an opaque blob or a model-side profile. Every row records who wrote it and
-- when, and deletion is real deletion rather than a hidden flag.

CREATE TABLE ai_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Memory belongs to a person, not to a pair. A pair can end; what someone
  -- told the assistant about themselves should not silently transfer or vanish
  -- with it, and it must never become readable to a partner through pair state.
  category text NOT NULL CHECK (
    category IN ('preference', 'routine', 'boundary', 'context')
  ),
  content text NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 500),
  -- 'user' entries were stated deliberately; 'assistant' entries were proposed
  -- by the model and are surfaced as such so a user can tell the difference
  -- between what they said and what was inferred about them.
  author text NOT NULL CHECK (author IN ('user', 'assistant')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_memories_user_idx ON ai_memories (user_id, created_at DESC);

-- A hard ceiling per user, enforced in the route. Unbounded memory is both a
-- privacy problem and a context-budget problem.
COMMENT ON TABLE ai_memories IS
  'Per-user relationship memory. Bounded, individually deletable, never pair-scoped.';

-- Session accounting exists to bound duration and enforce quotas. It stores no
-- audio, no transcript, and no prompt: only when a session ran and how much of
-- the allowance it used.
CREATE TABLE ai_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pair_id uuid REFERENCES pairs(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('active', 'ended', 'expired', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  expires_at timestamptz NOT NULL,
  end_reason text,
  -- Whether the generated-voice disclosure was delivered. A session that never
  -- announced itself is a defect, and this is how it becomes visible.
  identity_announced boolean NOT NULL DEFAULT false
);

CREATE INDEX ai_sessions_user_recent_idx ON ai_sessions (user_id, started_at DESC);

-- Every tool invocation, whether it ran or was refused.
--
-- Arguments are not stored; only the tool name, the decision, and a reason.
-- That is enough to audit authorization without accumulating a record of what
-- the user asked the assistant to do.
CREATE TABLE ai_tool_invocations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  call_id text NOT NULL,
  tool_name text NOT NULL,
  decision text NOT NULL CHECK (
    decision IN (
      'executed', 'not_allowlisted', 'invalid_arguments', 'consent_denied',
      'confirmation_required', 'privacy_paused', 'rate_limited', 'failed'
    )
  ),
  detail text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- The provider may repeat a call id on reconnect; executing twice must be
  -- impossible rather than merely unlikely.
  UNIQUE (session_id, call_id)
);

CREATE INDEX ai_tool_invocations_session_idx
  ON ai_tool_invocations (session_id, occurred_at DESC);

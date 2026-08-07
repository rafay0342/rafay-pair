-- Single-use tickets for the AI voice socket.
--
-- The audio bridge cannot authenticate the way an HTTP route does: browsers and
-- native socket clients cannot set an Authorization header on a WebSocket
-- handshake, and putting a bearer token in the query string writes it into
-- every proxy and access log along the path. The realtime socket already solves
-- this with a short-lived single-use ticket carried in the subprotocol header,
-- and the voice socket uses the same shape.
--
-- The ticket lives on the session row rather than in a separate table because
-- it is a property of exactly one session, and because consuming it is then a
-- single conditional UPDATE — atomic without a lock, and impossible to redeem
-- twice.

ALTER TABLE ai_sessions
  -- Only the hash is stored. A leaked database backup must not yield a usable
  -- ticket, and the server never needs the original value again.
  ADD COLUMN voice_ticket_hash text,
  ADD COLUMN voice_ticket_expires_at timestamptz,
  -- Set when the socket is accepted. A second connection for the same session
  -- is refused rather than silently taking over the first one's audio.
  ADD COLUMN voice_connected_at timestamptz;

COMMENT ON COLUMN ai_sessions.voice_ticket_hash IS
  'SHA-256 of a single-use voice socket ticket. Cleared on redemption.';

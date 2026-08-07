import { type FormEvent, useId, useState } from "react";

import { getErrorMessage } from "../api/ApiError";
import { InlineAlert, PageSpinner } from "../components/Feedback";
import { usePair } from "../state/PairContext";

export function PairPage(): React.JSX.Element {
  const {
    loading,
    pair,
    partner,
    createPair,
    joinPair,
    disconnectPair,
    privacyPaused,
  } = usePair();
  const [busy, setBusy] = useState<"create" | "join" | "disconnect" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showDisconnect, setShowDisconnect] = useState(false);
  const joinCodeId = useId();
  const disconnectId = useId();

  if (loading) return <PageSpinner label="Loading your pair…" />;

  const inviteCode = pair?.joinCode;

  const handleCreate = async (): Promise<void> => {
    setBusy("create");
    setError(null);
    setSuccess(null);
    try {
      if (pair?.status === "waiting") await disconnectPair();
      await createPair();
      setSuccess(
        pair?.status === "waiting"
          ? "The previous invitation was invalidated and a new one-time code is ready."
          : "Your one-time pair code is ready. Share it privately with the person you trust.",
      );
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const handleJoin = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const codeValue = new FormData(form).get("code");
    const code = typeof codeValue === "string" ? codeValue : "";
    setBusy("join");
    setError(null);
    setSuccess(null);
    try {
      await joinPair(code);
      setSuccess(
        "Your pair is connected. Sharing remains off unless you grant it.",
      );
      form.reset();
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const copyCode = async (): Promise<void> => {
    if (!inviteCode) return;
    try {
      await navigator.clipboard.writeText(inviteCode);
      setSuccess("Pair code copied. Share it using a private channel.");
    } catch {
      setError(
        "Your browser blocked copying. Select the code and copy it manually.",
      );
    }
  };

  const handleDisconnect = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const confirmationValue = new FormData(event.currentTarget).get(
      "confirmation",
    );
    const confirmation =
      typeof confirmationValue === "string" ? confirmationValue : "";
    if (confirmation !== "DISCONNECT") {
      setError("Type DISCONNECT exactly to confirm.");
      return;
    }
    setBusy("disconnect");
    setError(null);
    try {
      await disconnectPair();
      setSuccess(
        "The pair was disconnected and all partner access was revoked.",
      );
      setShowDisconnect(false);
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page-stack narrow-page">
      <header className="page-heading">
        <p className="eyebrow">Pair connection</p>
        <h1>One trusted person. Clear boundaries.</h1>
        <p>
          A code can connect two accounts, but it never grants a sharing
          permission by itself.
        </p>
      </header>

      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      {success && <InlineAlert tone="success">{success}</InlineAlert>}

      {partner ? (
        <>
          <section className="partner-card" aria-labelledby="partner-heading">
            <div className="partner-avatar" aria-hidden="true">
              {partner.displayName.slice(0, 1).toUpperCase()}
            </div>
            <div className="partner-card-copy">
              <p className="eyebrow">Connected pair</p>
              <h2 id="partner-heading">{partner.displayName}</h2>
              <p>
                {privacyPaused
                  ? "Partner sharing is currently paused."
                  : "Connected for consent-led care."}
              </p>
            </div>
            <span
              className={`state-badge ${privacyPaused ? "state-badge--limited" : "state-badge--full"}`}
            >
              {privacyPaused ? "paused" : "connected"}
            </span>
          </section>

          <section className="boundary-card">
            <div>
              <p className="eyebrow">Pair boundary</p>
              <h2>Disconnecting revokes partner access</h2>
              <p>
                This ends the pair, invalidates live delivery, and prevents new
                partner-visible activity. It does not delete your individual
                account.
              </p>
            </div>
            {!showDisconnect ? (
              <button
                className="button button--danger-quiet"
                type="button"
                onClick={() => setShowDisconnect(true)}
              >
                Disconnect pair
              </button>
            ) : (
              <form
                className="confirmation-form"
                onSubmit={(event) => void handleDisconnect(event)}
              >
                <label htmlFor={disconnectId}>
                  Type <strong>DISCONNECT</strong> to confirm
                </label>
                <input
                  id={disconnectId}
                  name="confirmation"
                  type="text"
                  autoComplete="off"
                  required
                />
                <div className="button-row">
                  <button
                    className="button button--danger"
                    type="submit"
                    disabled={busy !== null}
                  >
                    {busy === "disconnect"
                      ? "Disconnecting…"
                      : "Revoke and disconnect"}
                  </button>
                  <button
                    className="button button--quiet"
                    type="button"
                    onClick={() => setShowDisconnect(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </section>
        </>
      ) : inviteCode ? (
        <section className="invite-card" aria-labelledby="invite-heading">
          <p className="eyebrow">Private invitation</p>
          <h2 id="invite-heading">Share this one-time code</h2>
          <button
            className="invite-code"
            type="button"
            onClick={() => void copyCode()}
            aria-label={`Copy pair code ${inviteCode}`}
          >
            {inviteCode}
            <span>Copy</span>
          </button>
          <p className="invite-expiry">
            This code expires automatically after 24 hours.
          </p>
          <InlineAlert tone="info">
            Send this code only to the person you intend to pair with. A
            connection still starts with every sharing category off unless you
            explicitly grant it.
          </InlineAlert>
        </section>
      ) : pair?.status === "waiting" ? (
        <section
          className="invite-card"
          aria-labelledby="hidden-invite-heading"
        >
          <p className="eyebrow">Waiting invitation</p>
          <h2 id="hidden-invite-heading">
            The original code is no longer displayed
          </h2>
          <p>
            Join codes are shown only when created. Replace the invitation to
            invalidate the old code and receive a new one.
          </p>
          <button
            className="button"
            type="button"
            disabled={busy !== null}
            onClick={() => void handleCreate()}
          >
            {busy === "create" ? "Replacing code…" : "Replace invitation code"}
          </button>
        </section>
      ) : (
        <div className="pair-choice-grid">
          <section className="action-card">
            <span className="action-number" aria-hidden="true">
              01
            </span>
            <p className="eyebrow">Invite someone</p>
            <h2>Create a private pair code</h2>
            <p>
              The code is time-limited and intended for one person. Share it
              through a channel you trust.
            </p>
            <button
              className="button"
              type="button"
              disabled={busy !== null}
              onClick={() => void handleCreate()}
            >
              {busy === "create" ? "Creating code…" : "Create pair code"}
            </button>
          </section>

          <section className="action-card">
            <span className="action-number" aria-hidden="true">
              02
            </span>
            <p className="eyebrow">Accept an invitation</p>
            <h2>Join with their code</h2>
            <p>
              Entering a code connects the pair. It does not switch on any
              data-sharing category.
            </p>
            <form
              className="join-form"
              onSubmit={(event) => void handleJoin(event)}
            >
              <label htmlFor={joinCodeId}>Pair code</label>
              <input
                id={joinCodeId}
                name="code"
                type="text"
                minLength={8}
                maxLength={8}
                pattern="[A-Z2-9]{8}"
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                required
              />
              <button
                className="button button--quiet"
                type="submit"
                disabled={busy !== null}
              >
                {busy === "join" ? "Joining…" : "Join pair"}
              </button>
            </form>
          </section>
        </div>
      )}

      <section className="plain-language-section">
        <h2>What pairing does — and does not do</h2>
        <dl className="definition-grid">
          <div>
            <dt>It does</dt>
            <dd>
              Create a secure route for care requests and approved updates.
            </dd>
          </div>
          <div>
            <dt>It does not</dt>
            <dd>
              Allow remote camera, microphone, location, or sensor activation.
            </dd>
          </div>
          <div>
            <dt>You control</dt>
            <dd>
              Every sharing category, privacy pause, and the connection itself.
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

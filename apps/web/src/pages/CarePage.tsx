import { type FormEvent, useId, useMemo, useState } from "react";
import { Link } from "../routing/Router";

import { getErrorMessage } from "../api/ApiError";
import { EmptyState, InlineAlert, PageSpinner } from "../components/Feedback";
import type { CareKind, CareRequest, CareResponse } from "../domain/types";
import { useAuth } from "../state/AuthContext";
import { usePair } from "../state/PairContext";

interface CareChoice {
  readonly kind: CareKind;
  readonly title: string;
  readonly description: string;
  readonly glyph: string;
}

const careChoices: readonly CareChoice[] = [
  {
    kind: "check_in",
    title: "Check in with me",
    description: "Ask for a gentle moment together.",
    glyph: "♡",
  },
  {
    kind: "encouragement",
    title: "Send encouragement",
    description: "Share a small, supportive nudge.",
    glyph: "✦",
  },
  {
    kind: "breathe_together",
    title: "Breathe together",
    description: "Invite a short guided pause.",
    glyph: "○",
  },
  {
    kind: "move_together",
    title: "Move together",
    description: "Invite a shared movement break.",
    glyph: "↗",
  },
  {
    kind: "call_me",
    title: "Call me",
    description: "Ask your partner to contact you.",
    glyph: "↙",
  },
  {
    kind: "help",
    title: "I need help",
    description: "Tell your partner you need support.",
    glyph: "!",
  },
];

const careTitles: Readonly<Record<CareKind, string>> = {
  check_in: "Check in with me",
  encouragement: "Send encouragement",
  breathe_together: "Breathe together",
  move_together: "Move together",
  call_me: "Call me",
  help: "I need help",
};

function formatDate(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function RequestCard({
  request,
  incoming,
  counterpartName,
  busy,
  onRespond,
}: {
  readonly request: CareRequest;
  readonly incoming: boolean;
  readonly counterpartName: string;
  readonly busy: boolean;
  readonly onRespond: (response: CareResponse) => void;
}): React.JSX.Element {
  return (
    <article className="care-request-card">
      <div className="care-request-glyph" aria-hidden="true">
        {careChoices.find((choice) => choice.kind === request.kind)?.glyph ??
          "♡"}
      </div>
      <div className="care-request-content">
        <div className="care-request-meta">
          <span>
            {incoming ? `From ${counterpartName}` : `To ${counterpartName}`}
          </span>
          <time dateTime={request.createdAt}>
            {formatDate(request.createdAt)}
          </time>
        </div>
        <h3>{careTitles[request.kind]}</h3>
        {request.message && <p className="care-message">“{request.message}”</p>}
        {request.status === "pending" && incoming ? (
          <div className="button-row">
            <button
              className="button button--small"
              type="button"
              disabled={busy}
              onClick={() => onRespond("accepted")}
            >
              Accept
            </button>
            <button
              className="button button--small button--quiet"
              type="button"
              disabled={busy}
              onClick={() => onRespond("declined")}
            >
              Not now
            </button>
          </div>
        ) : (
          <span className={`request-status request-status--${request.status}`}>
            {request.status.replace("_", " ")}
          </span>
        )}
      </div>
    </article>
  );
}

export function CarePage(): React.JSX.Element {
  const { user } = useAuth();
  const {
    loading,
    partner,
    consents,
    careRequests,
    drafts,
    privacyPaused,
    partnerPrivacyPaused,
    sharingBlocked,
    sendCareRequest,
    respondToCareRequest,
    syncDrafts,
    discardDraft,
  } = usePair();
  const [selectedKind, setSelectedKind] = useState<CareKind>("check_in");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const messageId = useId();

  const incoming = useMemo(
    () =>
      careRequests.filter((request) => request.recipientUserId === user?.id),
    [careRequests, user?.id],
  );
  const outgoing = useMemo(
    () => careRequests.filter((request) => request.senderUserId === user?.id),
    [careRequests, user?.id],
  );
  const careConsent =
    consents.find((grant) => grant.capability === "care_requests")?.granted ??
    false;

  if (loading) return <PageSpinner label="Opening care requests…" />;

  const handleSend = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const messageValue = new FormData(form).get("message");
    const message = typeof messageValue === "string" ? messageValue : "";
    setBusy("send");
    setError(null);
    setSuccess(null);
    try {
      const outcome = await sendCareRequest({
        kind: selectedKind,
        ...(message.trim() ? { message } : {}),
      });
      form.reset();
      setSuccess(
        outcome === "sent"
          ? `Your request was sent to ${partner?.displayName ?? "your partner"}.`
          : "A message-free draft was saved on this device. Consent will be checked again before it sends.",
      );
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const handleRespond = async (
    id: string,
    response: CareResponse,
  ): Promise<void> => {
    setBusy(id);
    setError(null);
    try {
      await respondToCareRequest(id, response);
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const handleSync = async (): Promise<void> => {
    setBusy("sync");
    setError(null);
    try {
      await syncDrafts();
      setSuccess(
        "Eligible drafts were sent after checking your current consent and pair status.",
      );
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  if (!partner) {
    return (
      <div className="page-stack narrow-page">
        <header className="page-heading">
          <p className="eyebrow">Care requests</p>
          <h1>A request is an invitation, not a demand.</h1>
        </header>
        <EmptyState
          eyebrow="No active pair"
          title="Connect before sending care"
        >
          <p>Care requests travel only between two securely paired accounts.</p>
          <Link className="button" to="/pair">
            Connect your pair
          </Link>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="page-stack">
      <header className="page-heading page-heading--split">
        <div>
          <p className="eyebrow">Care requests</p>
          <h1>Ask clearly. Answer freely.</h1>
          <p>
            Every request can be accepted or declined without changing the
            relationship connection.
          </p>
        </div>
        <div className="care-principle">
          <span aria-hidden="true">♡</span>
          <p>
            <strong>No pressure.</strong>
            <br />
            “Not now” is always a complete answer.
          </p>
        </div>
      </header>

      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      {success && <InlineAlert tone="success">{success}</InlineAlert>}
      {privacyPaused && (
        <InlineAlert tone="warning" title="Sharing is paused">
          Partner delivery and the shared request history are blocked until you
          explicitly resume.
        </InlineAlert>
      )}
      {partnerPrivacyPaused && (
        <InlineAlert
          tone="info"
          title={`${partner.displayName} paused sharing`}
        >
          Pair-visible care is unavailable until your partner resumes their
          privacy state.
        </InlineAlert>
      )}
      {!careConsent && (
        <InlineAlert tone="info" title="New requests to you are off">
          Your partner cannot send you a new care request until you allow it in
          the <Link to="/consent">Consent center</Link>. Requests you send
          remain governed by your partner’s consent.
        </InlineAlert>
      )}

      <section className="care-compose" aria-labelledby="compose-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">For {partner.displayName}</p>
            <h2 id="compose-heading">What would feel supportive?</h2>
          </div>
        </div>

        <form onSubmit={(event) => void handleSend(event)}>
          <fieldset
            className="care-choice-grid"
            disabled={busy !== null || sharingBlocked}
          >
            <legend className="sr-only">Choose a care request</legend>
            {careChoices.map((choice) => (
              <label
                key={choice.kind}
                className={`care-choice ${selectedKind === choice.kind ? "is-selected" : ""}`}
              >
                <input
                  type="radio"
                  name="kind"
                  value={choice.kind}
                  checked={selectedKind === choice.kind}
                  onChange={() => setSelectedKind(choice.kind)}
                />
                <span className="care-choice-glyph" aria-hidden="true">
                  {choice.glyph}
                </span>
                <strong>{choice.title}</strong>
                <small>{choice.description}</small>
              </label>
            ))}
          </fieldset>

          {selectedKind === "help" && (
            <InlineAlert tone="warning">
              RafayPair is not monitored and cannot contact emergency services.
              If anyone is in immediate danger, contact local emergency services
              now.
            </InlineAlert>
          )}

          <div className="compose-footer">
            <div className="field compose-message">
              <label htmlFor={messageId}>Optional private note</label>
              <textarea
                id={messageId}
                name="message"
                rows={3}
                maxLength={500}
                placeholder="Only add what you are comfortable sending now."
                disabled={busy !== null || sharingBlocked}
              />
              <small>Notes are never saved as offline drafts.</small>
            </div>
            <button
              className="button"
              type="submit"
              disabled={busy !== null || sharingBlocked}
            >
              {busy === "send"
                ? "Sending…"
                : navigator.onLine
                  ? "Send request"
                  : "Save safe draft"}
            </button>
          </div>
        </form>
      </section>

      {drafts.length > 0 && (
        <section className="draft-section" aria-labelledby="draft-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">On this device only</p>
              <h2 id="draft-heading">Waiting to send</h2>
            </div>
            <button
              className="button button--small button--quiet"
              type="button"
              disabled={busy !== null}
              onClick={() => void handleSync()}
            >
              {busy === "sync" ? "Checking…" : "Check and send"}
            </button>
          </div>
          <p className="section-note">
            These drafts contain only the request type—never a note. Current
            consent is checked before delivery.
          </p>
          <ul className="draft-list">
            {drafts.map((draft) => (
              <li key={draft.clientRequestId}>
                <div>
                  <strong>{careTitles[draft.kind]}</strong>
                  <span>{formatDate(draft.createdAt)}</span>
                </div>
                <button
                  className="text-button text-button--danger"
                  type="button"
                  onClick={() => void discardDraft(draft.clientRequestId)}
                >
                  Discard
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="request-columns">
        <section aria-labelledby="inbox-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Received</p>
              <h2 id="inbox-heading">Your inbox</h2>
            </div>
            <span className="count-pill">
              {
                incoming.filter((request) => request.status === "pending")
                  .length
              }{" "}
              pending
            </span>
          </div>
          {incoming.length === 0 ? (
            <EmptyState title="Nothing waiting for you">
              <p>New requests will appear here in real time.</p>
            </EmptyState>
          ) : (
            <div className="request-list">
              {incoming.map((request) => (
                <RequestCard
                  key={request.id}
                  request={request}
                  incoming
                  counterpartName={partner.displayName}
                  busy={busy === request.id}
                  onRespond={(response) =>
                    void handleRespond(request.id, response)
                  }
                />
              ))}
            </div>
          )}
        </section>

        <section aria-labelledby="sent-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Sent</p>
              <h2 id="sent-heading">Your requests</h2>
            </div>
          </div>
          {outgoing.length === 0 ? (
            <EmptyState title="No requests sent">
              <p>Choose a care gesture above when it feels useful.</p>
            </EmptyState>
          ) : (
            <div className="request-list">
              {outgoing.map((request) => (
                <RequestCard
                  key={request.id}
                  request={request}
                  incoming={false}
                  counterpartName={partner.displayName}
                  busy={false}
                  onRespond={() => undefined}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

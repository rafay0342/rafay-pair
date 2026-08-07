import { ConnectionStatus } from "../components/ConnectionStatus";
import { InlineAlert, PageSpinner } from "../components/Feedback";
import type { CareKind } from "../domain/types";
import { Link } from "../routing/Router";
import { useAuth } from "../state/AuthContext";
import { usePair } from "../state/PairContext";

const careLabels: Readonly<Record<CareKind, string>> = {
  check_in: "Check in",
  encouragement: "Encouragement",
  breathe_together: "Breathe together",
  move_together: "Move together",
  call_me: "Call me",
  help: "Help requested",
};

function formatRelativeTime(timestamp: string): string {
  const elapsedSeconds = Math.max(
    0,
    Math.round((Date.now() - Date.parse(timestamp)) / 1000),
  );
  if (elapsedSeconds < 60) return "just now";
  if (elapsedSeconds < 3600)
    return `${String(Math.floor(elapsedSeconds / 60))}m ago`;
  if (elapsedSeconds < 86_400)
    return `${String(Math.floor(elapsedSeconds / 3600))}h ago`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}

export function HomePage(): React.JSX.Element {
  const { user } = useAuth();
  const {
    loading,
    partner,
    careRequests,
    consents,
    realtimeStatus,
    privacyPaused,
    sharingBlocked,
    drafts,
  } = usePair();

  if (loading) return <PageSpinner label="Opening your private space…" />;

  const pendingIncoming = careRequests.filter(
    (request) =>
      request.status === "pending" && request.recipientUserId === user?.id,
  );
  const grantedCount = consents.filter((grant) => grant.granted).length;

  return (
    <div className="page-stack home-page">
      {sharingBlocked && (
        <InlineAlert tone="warning" title="Partner sharing is paused">
          {privacyPaused
            ? "Nothing new is being shared. You decide when to resume from the Privacy page."
            : `${partner?.displayName ?? "Your partner"} paused sharing. Only they can resume their side.`}
        </InlineAlert>
      )}

      <section className="connection-hero" aria-labelledby="home-heading">
        <div className="connection-hero-copy">
          <p className="eyebrow">
            {partner ? "Your shared space" : "Your space is ready"}
          </p>
          <h1 id="home-heading">
            {partner
              ? `Stay close to ${partner.displayName}, gently.`
              : `Hello, ${user?.displayName}.`}
          </h1>
          <p>
            {partner
              ? "Real care begins with a request, not silent access. Your sharing choices remain yours."
              : "Connect with one trusted person to exchange consent-led care requests."}
          </p>
          <div className="hero-actions">
            <Link className="button" to={partner ? "/care" : "/pair"}>
              {partner ? "Send a care request" : "Connect your pair"}
            </Link>
            <Link className="button button--quiet" to="/consent">
              Review consent
            </Link>
          </div>
        </div>

        <div
          className="pair-portrait"
          aria-label={
            partner ? `You and ${partner.displayName}` : "Waiting for your pair"
          }
        >
          <div className="person-orb person-orb--you">
            <span>{user?.displayName.slice(0, 1).toUpperCase()}</span>
            <small>You</small>
          </div>
          <div
            className={`pair-thread ${partner && !sharingBlocked ? "is-connected" : ""}`}
            aria-hidden="true"
          >
            <i />
            <i />
            <i />
          </div>
          <div
            className={`person-orb person-orb--partner ${partner ? "" : "is-empty"}`}
          >
            <span>{partner?.displayName.slice(0, 1).toUpperCase() ?? "?"}</span>
            <small>{partner?.displayName ?? "Your pair"}</small>
          </div>
        </div>
      </section>

      <section className="status-grid" aria-label="Current pair status">
        <article className="status-card status-card--live">
          <div className="status-card-topline">
            <span className="status-card-icon" aria-hidden="true">
              ↔
            </span>
            <ConnectionStatus status={realtimeStatus} />
          </div>
          <h2>Pair connection</h2>
          <p>
            {partner
              ? realtimeStatus === "connected"
                ? "Secure live delivery is active."
                : "Updates recover automatically after reconnecting."
              : "Connect one trusted person to begin."}
          </p>
          <Link to="/pair">Manage pair</Link>
        </article>

        <article className="status-card">
          <div className="status-card-topline">
            <span className="status-card-icon" aria-hidden="true">
              ♡
            </span>
            {pendingIncoming.length > 0 && (
              <span className="count-pill">{pendingIncoming.length}</span>
            )}
          </div>
          <h2>Care inbox</h2>
          <p>
            {pendingIncoming.length > 0
              ? `${String(pendingIncoming.length)} request${pendingIncoming.length === 1 ? "" : "s"} waiting for you.`
              : "No care request needs a response."}
          </p>
          <Link to="/care">Open care</Link>
        </article>

        <article className="status-card">
          <div className="status-card-topline">
            <span className="status-card-icon" aria-hidden="true">
              ✓
            </span>
            <span className="subtle-count">{grantedCount} on</span>
          </div>
          <h2>Active permissions</h2>
          <p>Only the categories you choose can be shared with your partner.</p>
          <Link to="/consent">See permissions</Link>
        </article>
      </section>

      {(pendingIncoming.length > 0 || drafts.length > 0) && (
        <section
          className="attention-section"
          aria-labelledby="attention-heading"
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">Needs your attention</p>
              <h2 id="attention-heading">A small moment of care</h2>
            </div>
            <Link to="/care">View all</Link>
          </div>
          <div className="attention-list">
            {pendingIncoming.slice(0, 2).map((request) => (
              <article key={request.id} className="attention-row">
                <span className="attention-mark" aria-hidden="true">
                  ♡
                </span>
                <div>
                  <strong>
                    {partner?.displayName ?? "Your partner"} asked to{" "}
                    {careLabels[request.kind].toLowerCase()}
                  </strong>
                  <p>{formatRelativeTime(request.createdAt)}</p>
                </div>
                <Link className="button button--small button--quiet" to="/care">
                  Respond
                </Link>
              </article>
            ))}
            {drafts.length > 0 && (
              <article className="attention-row">
                <span className="attention-mark" aria-hidden="true">
                  ↑
                </span>
                <div>
                  <strong>
                    {drafts.length} care draft{drafts.length === 1 ? "" : "s"}{" "}
                    waiting to send
                  </strong>
                  <p>Consent is checked again before delivery.</p>
                </div>
                <Link className="button button--small button--quiet" to="/care">
                  Review
                </Link>
              </article>
            )}
          </div>
        </section>
      )}

      <aside className="honesty-banner">
        <span className="honesty-mark" aria-hidden="true">
          i
        </span>
        <div>
          <strong>Scientifically honest by design</strong>
          <p>
            This foundation release does not show physiological measurements.
            RafayPair never invents health data.
          </p>
        </div>
        <Link to="/capabilities">Web capabilities</Link>
      </aside>
    </div>
  );
}

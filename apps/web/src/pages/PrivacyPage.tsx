import { useState } from "react";
import { Link } from "../routing/Router";

import { getErrorMessage } from "../api/ApiError";
import { EmptyState, InlineAlert, PageSpinner } from "../components/Feedback";
import { usePair } from "../state/PairContext";

export function PrivacyPage(): React.JSX.Element {
  const {
    loading,
    partner,
    privacyPaused,
    partnerPrivacyPaused,
    privacyPausePending,
    pausePrivacy,
    resumePrivacy,
    retryPrivacyPause,
  } = usePair();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading) return <PageSpinner label="Checking privacy state…" />;

  if (!partner) {
    return (
      <div className="page-stack narrow-page">
        <header className="page-heading">
          <p className="eyebrow">Privacy</p>
          <h1>Privacy controls stay close.</h1>
        </header>
        <EmptyState eyebrow="No partner access" title="Nothing is being shared">
          <p>There is no active pair. Your account remains private.</p>
          <Link className="button button--quiet" to="/pair">
            Pair settings
          </Link>
        </EmptyState>
      </div>
    );
  }

  const changePrivacy = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (privacyPaused) await resumePrivacy();
      else await pausePrivacy();
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const retryPause = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await retryPrivacyPause();
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-stack narrow-page privacy-page">
      <header className="page-heading">
        <p className="eyebrow">Privacy pause</p>
        <h1>One control stops partner sharing.</h1>
        <p>
          Pausing acts locally at once, then records the block on the server for
          every RafayPair client.
        </p>
      </header>

      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      {privacyPausePending && (
        <InlineAlert
          tone="warning"
          title="Paused here; server confirmation is pending"
        >
          This browser is blocking sharing now. Keep it paused and retry when
          connected so every client receives the block.
          <button
            className="text-button"
            type="button"
            disabled={busy}
            onClick={() => void retryPause()}
          >
            Retry confirmation
          </button>
        </InlineAlert>
      )}
      {partnerPrivacyPaused && (
        <InlineAlert
          tone="info"
          title={`${partner.displayName} paused sharing`}
        >
          Their pause blocks pair-visible activity in both directions. Only they
          can resume their privacy state.
        </InlineAlert>
      )}

      <section
        className={`privacy-control ${privacyPaused ? "is-paused" : ""}`}
        aria-labelledby="privacy-state-heading"
      >
        <div className="privacy-orbit" aria-hidden="true">
          <span>R</span>
          <i />
        </div>
        <p className="eyebrow">Current state</p>
        <h2 id="privacy-state-heading">
          {privacyPaused
            ? "Partner sharing is paused"
            : "Sharing follows your consent choices"}
        </h2>
        <p>
          {privacyPaused
            ? `${partner.displayName} cannot receive new partner-visible updates from you.`
            : `Only categories marked “Allowed” can reach ${partner.displayName}.`}
        </p>
        <button
          className={`button ${privacyPaused ? "" : "button--danger"}`}
          type="button"
          disabled={busy || privacyPausePending}
          onClick={() => void changePrivacy()}
        >
          {busy
            ? "Saving securely…"
            : privacyPaused
              ? "Resume approved sharing"
              : "Pause all partner sharing"}
        </button>
        {privacyPaused && (
          <small>
            Resuming restores only categories that are still individually
            allowed.
          </small>
        )}
      </section>

      <section
        className="pause-effects"
        aria-labelledby="pause-effects-heading"
      >
        <h2 id="pause-effects-heading">What pause does</h2>
        <div className="effect-grid">
          <article>
            <span aria-hidden="true">■</span>
            <h3>Blocks new sharing</h3>
            <p>
              Partner-visible presence, care delivery, and approved derived
              events stop.
            </p>
          </article>
          <article>
            <span aria-hidden="true">□</span>
            <h3>Leaves sensors alone</h3>
            <p>
              Your partner cannot activate a camera, microphone, or phone
              sensor—with or without pause.
            </p>
          </article>
          <article>
            <span aria-hidden="true">↺</span>
            <h3>Keeps your choices</h3>
            <p>
              Individual permissions remain visible so you can revoke them
              before resuming.
            </p>
          </article>
        </div>
      </section>

      <div className="privacy-links">
        <Link to="/consent">Review individual permissions</Link>
        <Link to="/pair">Disconnect the pair</Link>
      </div>
    </div>
  );
}

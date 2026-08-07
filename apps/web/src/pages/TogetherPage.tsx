import { useCallback, useEffect, useState } from "react";

import { ApiError, getErrorMessage } from "../api/ApiError";
import { apiClient } from "../api/client";
import { InlineAlert, PageSpinner } from "../components/Feedback";
import type { TogetherActivity, TogetherSession } from "../domain/types";
import { usePair } from "../state/PairContext";

/**
 * Together mode.
 *
 * Master specification §10: both phones detect their own user and exchange only
 * derived session state. No frame, landmark, or audio sample is transmitted, and
 * there is no field in the contract through which one could be.
 */
export function TogetherPage(): React.JSX.Element {
  const { partner, sharingBlocked } = usePair();
  const [session, setSession] = useState<TogetherSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setSession(await apiClient.currentTogetherSession());
      setError(null);
    } catch (caught) {
      // A pair that has ended, or a privacy pause, is a state rather than a
      // failure: the surface simply has nothing to show.
      if (caught instanceof ApiError && caught.status === 403) setSession(null);
      else setError(getErrorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Polling is deliberate here rather than driving the page from the realtime
    // socket: the session surface must be correct on first paint, before any
    // socket has connected.
    const handle = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(handle);
  }, [refresh]);

  const run = useCallback(
    async (action: () => Promise<TogetherSession | null>): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        setSession(await action());
      } catch (caught) {
        setError(getErrorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  if (loading) return <PageSpinner label="Checking for a shared session…" />;

  return (
    <div className="page-stack narrow-page">
      <header className="page-heading">
        <p className="eyebrow">Together</p>
        <h1>Work out at the same time.</h1>
        <p>
          Each phone watches only its own person. What crosses between you is
          the count and the phase — never the camera.
        </p>
      </header>

      {error && <InlineAlert tone="error">{error}</InlineAlert>}

      {!partner && (
        <InlineAlert tone="info" title="No partner yet">
          Together mode needs an active pair.
        </InlineAlert>
      )}

      {partner && sharingBlocked && (
        <InlineAlert tone="warning" title="Sharing is paused">
          Resume sharing before starting a session together.
        </InlineAlert>
      )}

      {partner && !sharingBlocked && !session && (
        <section className="privacy-control" aria-labelledby="together-start">
          <h2 id="together-start">Invite {partner.displayName}</h2>
          <p>
            They will be asked before anything is shared, and either of you can
            end the session at any moment.
          </p>
          <div className="breath-choices">
            {(
              [
                ["squat", "Squats"],
                ["bodyweightMixed", "Mixed bodyweight"],
                ["guidedBreathing", "Guided breathing"],
              ] as const satisfies readonly (readonly [
                TogetherActivity,
                string,
              ])[]
            ).map(([activity, label]) => (
              <button
                key={activity}
                className="button button--quiet"
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(() => apiClient.inviteTogetherSession(activity))
                }
              >
                {label}
              </button>
            ))}
          </div>
        </section>
      )}

      {session && (
        <TogetherSessionCard
          session={session}
          busy={busy}
          onRespond={(response) =>
            void run(() =>
              apiClient.respondToTogetherSession(session.id, response),
            )
          }
          onEnd={() => void run(() => apiClient.endTogetherSession(session.id))}
        />
      )}

      <section className="pause-effects" aria-labelledby="together-privacy">
        <h2 id="together-privacy">What is shared</h2>
        <p>
          Repetition count, exercise phase, set number, elapsed time, estimated
          calories, and breathing phase. That is the whole list.
        </p>
        <p className="form-hint">
          Ending the session deletes the state that was exchanged. Revoking
          workout sharing hides your partner&rsquo;s progress immediately, even
          mid-session.
        </p>
      </section>
    </div>
  );
}

interface SessionCardProps {
  readonly session: TogetherSession;
  readonly busy: boolean;
  readonly onRespond: (response: "accepted" | "declined") => void;
  readonly onEnd: () => void;
}

function TogetherSessionCard({
  session,
  busy,
  onRespond,
  onEnd,
}: SessionCardProps): React.JSX.Element {
  const waiting = session.status === "invited";
  return (
    <section className="privacy-control" aria-labelledby="together-session">
      <h2 id="together-session">{activityLabel(session.activity)}</h2>
      <p>{statusLabel(session)}</p>

      {session.participants.length > 0 && (
        <ul className="together-participants">
          {session.participants.map((participant) => (
            <li key={participant.userId}>
              <strong>{participant.repetitions}</strong> reps · set{" "}
              {participant.setIndex + 1} · {participant.exercisePhase}
              {participant.estimatedKcal !== null && (
                <> · ~{Math.round(participant.estimatedKcal)} kcal</>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="breath-choices">
        {waiting && (
          <>
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => onRespond("accepted")}
            >
              Join
            </button>
            <button
              className="button button--quiet"
              type="button"
              disabled={busy}
              onClick={() => onRespond("declined")}
            >
              Not now
            </button>
          </>
        )}
        <button
          className="button button--danger"
          type="button"
          disabled={busy}
          onClick={onEnd}
        >
          End session
        </button>
      </div>
    </section>
  );
}

function activityLabel(activity: TogetherActivity): string {
  switch (activity) {
    case "squat":
      return "Squats together";
    case "bodyweightMixed":
      return "Mixed bodyweight together";
    case "guidedBreathing":
      return "Breathing together";
    default:
      return "Together";
  }
}

function statusLabel(session: TogetherSession): string {
  switch (session.status) {
    case "invited":
      return "Waiting for an answer.";
    case "active":
      return "In progress.";
    case "declined":
      return "Declined.";
    case "ended":
      return "Ended.";
    case "expired":
      return "The invitation expired.";
    default:
      return "";
  }
}

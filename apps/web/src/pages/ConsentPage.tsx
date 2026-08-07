import { useState } from "react";
import { Link } from "../routing/Router";

import { getErrorMessage } from "../api/ApiError";
import { EmptyState, InlineAlert, PageSpinner } from "../components/Feedback";
import type { ConsentCapability } from "../domain/types";
import { usePair } from "../state/PairContext";

interface ConsentDefinition {
  readonly capability: ConsentCapability;
  readonly title: string;
  readonly description: string;
  readonly includes: string;
  readonly excludes: string;
}

const consentDefinitions: readonly ConsentDefinition[] = [
  {
    capability: "care_requests",
    title: "Care requests",
    description: "Exchange explicit check-ins, encouragement, and invitations.",
    includes: "Request type, optional note, response, and time.",
    excludes: "Camera, microphone, location, and sensor access.",
  },
  {
    capability: "presence",
    title: "Live presence",
    description: "Let your partner know when you are available in RafayPair.",
    includes: "Online or offline state and last connection time.",
    excludes: "Location, device activity, and background tracking.",
  },
  {
    capability: "workout_progress",
    title: "Workout progress",
    description:
      "Share approved derived exercise progress during a together session.",
    includes: "Exercise phase, rep count, set progress, and elapsed time.",
    excludes: "Camera frames, recordings, and raw landmarks.",
  },
  {
    capability: "pulse_snapshots",
    title: "Pulse snapshots",
    description: "Allow a pulse estimate you explicitly approve to be shared.",
    includes: "Estimate, confidence, provenance, and measurement time.",
    excludes: "Continuous heart rate or silent camera measurement.",
  },
  {
    capability: "breathing_state",
    title: "Breathing session state",
    description: "Share whether an intentional breathing session is active.",
    includes: "Session state and approved derived rhythm where available.",
    excludes: "Raw microphone audio or camera footage.",
  },
  {
    capability: "estimated_calories",
    title: "Estimated calories",
    description:
      "Share an algorithm-labeled calorie range from an approved workout.",
    includes: "Estimate, confidence band, and algorithm version.",
    excludes: "A medical claim or a directly measured calorie value.",
  },
  {
    capability: "ai_partner_context",
    title: "Partner context for Rafay AI",
    description:
      "Permit approved partner context to inform an AI conversation.",
    includes:
      "Only categories separately allowed here and needed for the session.",
    excludes: "New access, hidden memory, and permission changes by AI.",
  },
];

export function ConsentPage(): React.JSX.Element {
  const { loading, partner, consents, updateConsent, privacyPaused } =
    usePair();
  const [busy, setBusy] = useState<ConsentCapability | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  if (loading) return <PageSpinner label="Loading your consent choices…" />;

  if (!partner) {
    return (
      <div className="page-stack narrow-page">
        <header className="page-heading">
          <p className="eyebrow">Consent center</p>
          <h1>Sharing begins with a clear yes.</h1>
        </header>
        <EmptyState
          eyebrow="No active pair"
          title="Consent stays individual until you connect"
        >
          <p>
            Connect your pair, then decide category by category what may be
            shared.
          </p>
          <Link className="button" to="/pair">
            Connect your pair
          </Link>
        </EmptyState>
      </div>
    );
  }

  const changeConsent = async (
    capability: ConsentCapability,
    granted: boolean,
  ): Promise<void> => {
    setBusy(capability);
    setError(null);
    try {
      await updateConsent({ capability, granted });
      const definition = consentDefinitions.find(
        (item) => item.capability === capability,
      );
      setAnnouncement(
        `${definition?.title ?? "Permission"} ${granted ? "allowed" : "stopped"}.`,
      );
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page-stack narrow-page consent-page">
      <header className="page-heading page-heading--split">
        <div>
          <p className="eyebrow">Consent center</p>
          <h1>Your data. Your yes. Your no.</h1>
          <p>
            These choices apply to {partner.displayName} across RafayPair. A
            permission never activates a sensor by itself.
          </p>
        </div>
        <div
          className="consent-summary"
          aria-label={`${consents.filter((grant) => grant.granted).length} permissions on`}
        >
          <strong>{consents.filter((grant) => grant.granted).length}</strong>
          <span>permissions on</span>
        </div>
      </header>

      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      {privacyPaused && (
        <InlineAlert tone="warning" title="Global sharing pause is active">
          Your saved choices are visible below, but partner delivery is blocked
          until you resume. You can still revoke any permission while paused.
        </InlineAlert>
      )}

      <section
        className="consent-list"
        aria-label="Partner sharing permissions"
      >
        {consentDefinitions.map((definition) => {
          const granted =
            consents.find((grant) => grant.capability === definition.capability)
              ?.granted ?? false;
          const updating = busy === definition.capability;
          return (
            <article className="consent-row" key={definition.capability}>
              <div className="consent-copy">
                <div className="consent-title-row">
                  <h2>{definition.title}</h2>
                  <span
                    className={`permission-state ${granted ? "is-on" : ""}`}
                  >
                    {granted ? "Allowed" : "Off"}
                  </span>
                </div>
                <p>{definition.description}</p>
                <details>
                  <summary>Exactly what this means</summary>
                  <dl>
                    <div>
                      <dt>Includes</dt>
                      <dd>{definition.includes}</dd>
                    </div>
                    <div>
                      <dt>Never includes</dt>
                      <dd>{definition.excludes}</dd>
                    </div>
                  </dl>
                </details>
              </div>
              <label className="switch">
                <span className="sr-only">Allow {definition.title}</span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-checked={granted}
                  checked={granted}
                  disabled={busy !== null}
                  onChange={(event) =>
                    void changeConsent(
                      definition.capability,
                      event.currentTarget.checked,
                    )
                  }
                />
                <span aria-hidden="true" />
              </label>
              {updating && (
                <span className="row-progress" aria-live="polite">
                  Saving…
                </span>
              )}
            </article>
          );
        })}
      </section>

      <aside className="consent-principles">
        <h2>Consent is checked when data is shared</h2>
        <ul>
          <li>Revoking a category blocks new partner access on the server.</li>
          <li>Pairing alone grants no category.</li>
          <li>Rafay AI cannot turn a permission on or bypass your choice.</li>
          <li>Disconnecting the pair revokes all partner access.</li>
        </ul>
      </aside>
    </div>
  );
}

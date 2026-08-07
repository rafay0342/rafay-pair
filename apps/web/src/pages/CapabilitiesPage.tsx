import type { CapabilityState } from "../domain/types";

interface CapabilityRow {
  readonly capability: string;
  readonly state: CapabilityState;
  readonly detail: string;
}

const capabilities: readonly CapabilityRow[] = [
  {
    capability: "Account, pairing, and consent",
    state: "full",
    detail:
      "Secure cookie sessions and server-enforced permissions are available on supported modern browsers.",
  },
  {
    capability: "Care requests and responses",
    state: "full",
    detail:
      "Live delivery, recovery, and explicit responses are supported while connected.",
  },
  {
    capability: "Offline care drafts",
    state: "limited",
    detail:
      "Only message-free, non-urgent request types can stay on this device for later consent-checked delivery.",
  },
  {
    capability: "Background live delivery",
    state: "limited",
    detail:
      "Browsers may suspend RafayPair when the tab or installed app is not active.",
  },
  {
    capability: "Browser push",
    state: "unsupported",
    detail:
      "Push registration is not exposed here. Keep RafayPair open for live care delivery, or use the phone apps.",
  },
  {
    capability: "Pose workouts",
    state: "limited",
    detail:
      "Camera pose runs in this browser, on this device. It needs the pose model, which is downloaded once and cached; without it the Move page says so rather than falling back to a server.",
  },
  {
    capability: "Together mode",
    state: "full",
    detail:
      "Invitations, shared sessions, and your partner's derived progress. The counting itself happens on whichever device is running the camera.",
  },
  {
    capability: "Phone-camera pulse",
    state: "unsupported",
    detail:
      "Measuring a pulse needs the rear lens with its torch lit and its exposure locked, which browsers do not expose reliably. Nothing here estimates one, and no fabricated number is shown.",
  },
  {
    capability: "Guided breathing",
    state: "full",
    detail:
      "The same deterministic schedule the phones use, so two partners can follow one rhythm. It needs no sensor and makes no physiological claim.",
  },
  {
    capability: "Microphone breathing estimate",
    state: "unsupported",
    detail:
      "Built on the phone apps, where the microphone can be held close and its state stays visible for the whole session. It is not offered here.",
  },
  {
    capability: "Rafay AI voice",
    state: "unsupported",
    detail:
      "Voice sessions run in the phone apps. What Rafay remembers is readable and deletable here, because that is yours to control wherever you are signed in.",
  },
  {
    capability: "HealthKit / Health Connect",
    state: "unsupported",
    detail: "Web browsers cannot provide native health-repository access.",
  },
];

const stateExplanations: Readonly<Record<CapabilityState, string>> = {
  full: "Works as designed on supported modern browsers.",
  limited: "Works with browser-specific constraints.",
  experimental:
    "Not enabled silently; requires separate validation and consent.",
  unsupported: "No product control is exposed for this capability here.",
};

const stateLegend: readonly {
  readonly state: CapabilityState;
  readonly explanation: string;
}[] = [
  { state: "full", explanation: stateExplanations.full },
  { state: "limited", explanation: stateExplanations.limited },
  { state: "experimental", explanation: stateExplanations.experimental },
  { state: "unsupported", explanation: stateExplanations.unsupported },
];

export function CapabilitiesPage(): React.JSX.Element {
  return (
    <div className="page-stack narrow-page capabilities-page">
      <header className="page-heading">
        <p className="eyebrow">Web capability map</p>
        <h1>Honest about what a browser can do.</h1>
        <p>
          RafayPair does not imitate native behavior when browser security,
          sensors, or background limits differ.
        </p>
      </header>

      <section
        className="capability-legend"
        aria-label="Capability state definitions"
      >
        {stateLegend.map(({ state, explanation }) => (
          <div key={state}>
            <span className={`state-badge state-badge--${state}`}>{state}</span>
            <p>{explanation}</p>
          </div>
        ))}
      </section>

      <section
        className="capability-table-wrap"
        aria-labelledby="capability-table-heading"
      >
        <h2 id="capability-table-heading" className="sr-only">
          Web capability states
        </h2>
        <table className="capability-table">
          <thead>
            <tr>
              <th scope="col">Capability</th>
              <th scope="col">Web state</th>
              <th scope="col">What to expect</th>
            </tr>
          </thead>
          <tbody>
            {capabilities.map((row) => (
              <tr key={row.capability}>
                <th scope="row">{row.capability}</th>
                <td>
                  <span className={`state-badge state-badge--${row.state}`}>
                    {row.state}
                  </span>
                </td>
                <td>{row.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <aside className="honesty-banner">
        <span className="honesty-mark" aria-hidden="true">
          i
        </span>
        <div>
          <strong>No hidden fallback measurements</strong>
          <p>
            Unavailable physiological data remains unavailable. RafayPair never
            interpolates a number and presents it as measured.
          </p>
        </div>
      </aside>
    </div>
  );
}

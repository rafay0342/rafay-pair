import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  BOX_PATTERN,
  CALM_PATTERN,
  RELAX_PATTERN,
  phaseAt,
  type BreathingPattern,
  type BreathingPhase,
} from "@rafay-pair/physiology-engine";

/**
 * Guided breathing, the living heart, and the blood-pressure position.
 *
 * Finger-camera pulse is deliberately absent here. The measurement needs the
 * rear camera with its torch lit and exposure locked; browsers expose neither
 * reliably, and without a lit fingertip the signal is not recoverable. Offering
 * a browser version anyway would mean shipping a worse estimate under the same
 * label, so the Web client says where the measurement lives instead.
 */
export function VitalsPage(): React.JSX.Element {
  const [pattern, setPattern] = useState<BreathingPattern | undefined>(
    undefined,
  );
  const startedAt = useRef<number | undefined>(undefined);
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    if (!pattern) return undefined;
    const handle = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(handle);
  }, [pattern]);

  const start = useCallback((next: BreathingPattern): void => {
    startedAt.current = performance.now();
    setNow(performance.now());
    setPattern(next);
  }, []);

  const stop = useCallback((): void => {
    startedAt.current = undefined;
    setPattern(undefined);
  }, []);

  const phase = useMemo(() => {
    if (!pattern || startedAt.current === undefined) return undefined;
    return phaseAt(pattern, now - startedAt.current);
  }, [now, pattern]);

  useEffect(() => {
    if (phase?.phase === "complete") stop();
  }, [phase, stop]);

  return (
    <div className="page-stack narrow-page">
      <header className="page-heading">
        <p className="eyebrow">Vitals</p>
        <h1>A calmer minute, on your terms.</h1>
        <p>
          Guided breathing runs entirely in this browser and measures nothing at
          all — it is only a rhythm to follow.
        </p>
      </header>

      <section className="privacy-control" aria-labelledby="breathing-heading">
        <h2 id="breathing-heading">
          {phase ? breathingLabel(phase.phase) : "Guided breathing"}
        </h2>
        {phase && pattern ? (
          <>
            <div
              className="breath-orb"
              data-phase={phase.phase}
              style={breathStyle(phase.progress)}
              aria-hidden="true"
            />
            <p>
              Cycle {phase.cycleIndex + 1} of {pattern.cycles}
            </p>
            <button className="button" type="button" onClick={stop}>
              Stop
            </button>
          </>
        ) : (
          <>
            <p>
              Choose a pattern. Both of you can follow the same one at the same
              time — the schedule is identical on every device.
            </p>
            <div className="breath-choices">
              <button
                className="button button--quiet"
                type="button"
                onClick={() => start(CALM_PATTERN(6))}
              >
                Calm
              </button>
              <button
                className="button button--quiet"
                type="button"
                onClick={() => start(BOX_PATTERN(5))}
              >
                Box
              </button>
              <button
                className="button button--quiet"
                type="button"
                onClick={() => start(RELAX_PATTERN(4))}
              >
                Relax
              </button>
            </div>
          </>
        )}
      </section>

      <section className="pause-effects" aria-labelledby="pulse-heading">
        <h2 id="pulse-heading">Pulse is measured on your phone</h2>
        <p>
          Measuring a pulse from a camera needs the rear lens with its torch lit
          and its exposure locked. Browsers do not offer either reliably, so
          RafayPair does not pretend to measure it here.
        </p>
        <p>
          Open the iOS or Android app to measure. Whatever you choose to share
          appears for your partner there.
        </p>
      </section>

      <section className="pause-effects" aria-labelledby="bp-heading">
        <h2 id="bp-heading">Blood pressure</h2>
        <p>
          RafayPair does not estimate blood pressure. A phone camera cannot
          measure it, and no amount of processing changes that.
        </p>
        <p>
          If you track it, enter a reading from a real cuff — that and an
          imported health record are the only sources this app accepts.
        </p>
      </section>
    </div>
  );
}

/** The orb reads its scale from a custom property, which React accepts on the
 * style object even though it is not a named CSS field. */
function breathStyle(progress: number): React.CSSProperties {
  return { "--breath-progress": String(progress) } as Record<
    string,
    string
  > satisfies Record<string, string>;
}

function breathingLabel(phase: BreathingPhase): string {
  switch (phase) {
    case "inhale":
      return "Breathe in";
    case "hold":
      return "Hold";
    case "exhale":
      return "Breathe out";
    case "holdAfter":
      return "Rest";
    case "complete":
      return "Done";
    default:
      return "Breathe";
  }
}

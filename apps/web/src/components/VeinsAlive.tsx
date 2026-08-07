import { useEffect, useRef, useState } from "react";

import {
  veinsDrivers,
  type BreathingPhase,
  type MuscleGroup,
  type VeinsMode,
} from "@rafay-pair/physiology-engine";

const MODES: readonly (readonly [VeinsMode, string])[] = [
  ["calm", "Calm"],
  ["workout", "Workout"],
  ["recovery", "Recovery"],
];

const BRANCHES = 7;

interface Props {
  readonly pulseBpm: number | null;
  readonly breathingPhase: BreathingPhase | null;
  readonly breathingProgress: number;
  readonly repetitionsPerMinute: number | null;
  readonly activeMuscles: readonly MuscleGroup[];
}

/**
 * Veins Alive.
 *
 * Master specification §8. Driven entirely by values the product already holds;
 * nothing here measures or infers. With no fresh pulse estimate the network
 * rests rather than falling back to a comfortable rhythm, because a moving
 * picture is the most persuasive way there is to state a number.
 *
 * Drawn as SVG rather than canvas so it inherits the page's colours in both
 * themes and can be hidden from assistive technology as one element — the
 * animation carries no information the surrounding text does not state.
 */
export function VeinsAlive({
  pulseBpm,
  breathingPhase,
  breathingProgress,
  repetitionsPerMinute,
  activeMuscles,
}: Props): React.JSX.Element {
  const [mode, setMode] = useState<VeinsMode>("calm");
  const [phase, setPhase] = useState(0);
  const frame = useRef<number>(0);

  const drivers = veinsDrivers({
    mode,
    pulseBpm,
    breathingPhase,
    breathingProgress,
    repetitionsPerMinute,
    activeMuscles,
  });
  const period = drivers.contractionPeriodMs;

  useEffect(() => {
    // No period means nothing current is known, so nothing animates. The frame
    // loop is not started rather than started and ignored.
    if (period === null) {
      setPhase(0);
      return undefined;
    }
    const started = performance.now();
    const step = (now: number): void => {
      setPhase(((now - started) % period) / period);
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.current);
  }, [period]);

  const beating = period !== null;
  const contraction = beating ? Math.max(0, 1 - Math.abs(phase - 0.15) * 6) : 0;

  return (
    <section className="privacy-control" aria-labelledby="veins-heading">
      <h2 id="veins-heading">Veins Alive</h2>

      {/* Above the picture, not under it: it is the first thing read, because
          the picture is the persuasive part. */}
      <p>
        <strong>{drivers.disclosure}</strong>
      </p>

      <div className="breath-choices">
        {MODES.map(([value, label]) => (
          <button
            key={value}
            className={
              mode === value
                ? "button button--small"
                : "button button--quiet button--small"
            }
            type="button"
            onClick={() => setMode(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <svg
        viewBox="0 0 200 240"
        className="veins-canvas"
        role="presentation"
        aria-hidden="true"
      >
        {drivers.chestGlow > 0 && (
          <circle
            cx="100"
            cy="104"
            r={40 + 24 * drivers.chestGlow}
            fill="currentColor"
            opacity={0.18 * drivers.chestGlow}
          />
        )}

        {Array.from({ length: BRANCHES }, (_, index) => {
          const fraction = index / (BRANCHES - 1);
          const x = 100 + (fraction - 0.5) * 150;
          const travel = beating
            ? Math.max(
                0,
                1 - Math.abs(((phase + fraction * 0.35) % 1) - 0.5) * 3,
              )
            : 0;
          return (
            <path
              key={index}
              d={`M100 90 C 100 130, ${x} 150, ${x} 200`}
              stroke="currentColor"
              strokeWidth={1.5 + 2.5 * travel}
              fill="none"
              opacity={0.18 + 0.55 * travel * drivers.intensity}
            />
          );
        })}

        <circle
          cx="100"
          cy="90"
          r={16 + 5 * contraction}
          fill="currentColor"
          opacity={0.35 + 0.4 * contraction}
        />

        {drivers.activeMuscles.map((muscle, index) => (
          <rect
            key={muscle}
            x="58"
            y={118 + index * 20}
            width="84"
            height="6"
            rx="3"
            fill="currentColor"
            opacity={0.2 + 0.5 * drivers.intensity}
          />
        ))}
      </svg>

      {/* Said in words as well as shown: stillness alone could be read as the
          app being broken. */}
      <p className="form-hint">
        {beating && pulseBpm !== null
          ? `Beating at your latest estimate, ${String(Math.round(pulseBpm))} bpm.`
          : "Resting. There is no current pulse estimate to animate."}
      </p>

      {drivers.activeMuscles.length > 0 && (
        <p className="form-hint">
          Highlighted: {drivers.activeMuscles.join(", ")} — the muscles this
          exercise works, from its definition.
        </p>
      )}
    </section>
  );
}

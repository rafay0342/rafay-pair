import { useCallback, useEffect, useState } from "react";

import { getErrorMessage } from "../api/ApiError";
import { apiClient } from "../api/client";
import type { BloodPressureReading } from "../domain/types";
import { InlineAlert } from "./Feedback";

/**
 * Blood pressure the user brings.
 *
 * Master specification §5: a phone is not a blood-pressure instrument, so the
 * product estimates nothing here. What it does do is hold a reading the user
 * took with a real cuff, because refusing to store it would not make anyone
 * safer — it would just send them to a notes app.
 *
 * Every reading shown carries where it came from. A typed reading and an
 * imported record look different on purpose: "externally sourced" without the
 * source is not provenance.
 */
export function BloodPressureCard(): React.JSX.Element {
  const [readings, setReadings] = useState<readonly BloodPressureReading[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [systolic, setSystolic] = useState("");
  const [diastolic, setDiastolic] = useState("");
  const [pulse, setPulse] = useState("");
  const [note, setNote] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await apiClient.bloodPressureReadings();
      setReadings(list.readings);
      setError(null);
    } catch (caught) {
      setError(getErrorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = useCallback(
    async (event: React.FormEvent): Promise<void> => {
      event.preventDefault();
      const systolicValue = Number.parseInt(systolic, 10);
      const diastolicValue = Number.parseInt(diastolic, 10);
      const pulseValue = pulse.trim() ? Number.parseInt(pulse, 10) : null;
      if (!Number.isInteger(systolicValue) || !Number.isInteger(diastolicValue))
        return;

      setBusy(true);
      try {
        await apiClient.recordBloodPressure({
          systolic: systolicValue,
          diastolic: diastolicValue,
          pulseBpm: pulseValue,
          measuredAt: new Date().toISOString(),
          note: note.trim() || null,
        });
        setSystolic("");
        setDiastolic("");
        setPulse("");
        setNote("");
        await refresh();
      } catch (caught) {
        setError(getErrorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [systolic, diastolic, pulse, note, refresh],
  );

  return (
    <section className="privacy-control" aria-labelledby="bp-heading">
      <h2 id="bp-heading">Blood pressure</h2>
      <p>
        RafayPair does not estimate blood pressure. A phone camera cannot
        measure it, and no amount of processing changes that. What you can do is
        keep readings from a real cuff here, alongside everything else.
      </p>

      {error && <InlineAlert tone="error">{error}</InlineAlert>}

      <form className="memory-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="bp-systolic">Systolic</label>
        <input
          id="bp-systolic"
          inputMode="numeric"
          value={systolic}
          onChange={(event) => setSystolic(event.target.value)}
          placeholder="118"
        />

        <label htmlFor="bp-diastolic">Diastolic</label>
        <input
          id="bp-diastolic"
          inputMode="numeric"
          value={diastolic}
          onChange={(event) => setDiastolic(event.target.value)}
          placeholder="76"
        />

        <label htmlFor="bp-pulse">Pulse on the cuff (optional)</label>
        <input
          id="bp-pulse"
          inputMode="numeric"
          value={pulse}
          onChange={(event) => setPulse(event.target.value)}
          placeholder="64"
        />

        <label htmlFor="bp-note">Note (optional)</label>
        <input
          id="bp-note"
          value={note}
          maxLength={280}
          onChange={(event) => setNote(event.target.value)}
          placeholder="After sitting for five minutes"
        />

        <button className="button" type="submit" disabled={busy}>
          Save reading
        </button>
      </form>

      <p className="form-hint">
        This is yours alone. There is no consent switch for blood pressure
        because there is no partner surface for it — it is never shared.
      </p>

      {readings.length > 0 && (
        <ul className="memory-list">
          {readings.map((reading) => (
            <li key={reading.id}>
              <strong>
                {reading.systolic}/{reading.diastolic}
              </strong>
              {reading.pulseBpm !== null && <span>{reading.pulseBpm} bpm</span>}
              <span className="memory-kind">
                {/* The origin travels with the reading, always. */}
                {reading.source === "manual_entry"
                  ? "entered by you"
                  : `from ${reading.externalOrigin ?? "a health record"}`}
              </span>
              <span>{new Date(reading.measuredAt).toLocaleString()}</span>
              <button
                className="text-button"
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void apiClient
                    .deleteBloodPressure(reading.id)
                    .then(refresh)
                    .catch((caught: unknown) =>
                      setError(getErrorMessage(caught)),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

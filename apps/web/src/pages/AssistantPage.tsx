import { useCallback, useEffect, useState } from "react";

import { getErrorMessage } from "../api/ApiError";
import { apiClient } from "../api/client";
import { InlineAlert, PageSpinner } from "../components/Feedback";
import type { AiMemory, AiMemoryCategory } from "../domain/types";

const CATEGORIES: readonly (readonly [AiMemoryCategory, string])[] = [
  ["preference", "Preference"],
  ["routine", "Routine"],
  ["boundary", "Boundary"],
  ["context", "Context"],
];

/**
 * Rafay AI: what it is, and what it remembers.
 *
 * The voice session itself runs on the phone apps, where there is a microphone
 * and a speaker under the user's hand. What lives here is the part that matters
 * most between sessions — the memory — because a user is entitled to read and
 * delete it in the same place they read anything else about their account.
 */
export function AssistantPage(): React.JSX.Element {
  const [memories, setMemories] = useState<readonly AiMemory[]>([]);
  const [limit, setLimit] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<AiMemoryCategory>("preference");
  const [content, setContent] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await apiClient.aiMemories();
      setMemories(list.memories);
      setLimit(list.limit);
      setError(null);
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (action: () => Promise<unknown>): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await action();
        await refresh();
      } catch (caught) {
        setError(getErrorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  if (loading) return <PageSpinner label="Loading what Rafay remembers…" />;

  return (
    <div className="page-stack narrow-page">
      <header className="page-heading">
        <p className="eyebrow">Rafay AI</p>
        <h1>A generated voice, not a person.</h1>
        <p>
          Rafay AI says so at the start of every session. It is not a clinician,
          and it speaks about camera estimates as estimates — never as measured
          readings.
        </p>
      </header>

      {error && <InlineAlert tone="error">{error}</InlineAlert>}

      <section className="pause-effects" aria-labelledby="assistant-voice">
        <h2 id="assistant-voice">Voice sessions</h2>
        <p>
          Voice runs in the iOS and Android apps, where the microphone state is
          visible for the whole session and stops the moment you end it.
        </p>
        <p className="form-hint">
          Anything the assistant does on your behalf — starting a breathing
          session, saving a memory — asks you first. It cannot confirm on its
          own.
        </p>
      </section>

      <section className="privacy-control" aria-labelledby="assistant-memory">
        <h2 id="assistant-memory">What Rafay remembers</h2>
        <p>
          {memories.length} of {limit} entries. Everything here is yours alone —
          your partner cannot see it, and it does not travel with the pair.
        </p>

        <form
          className="memory-form"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = content.trim();
            if (!trimmed) return;
            void run(async () => {
              await apiClient.addAiMemory({ category, content: trimmed });
              setContent("");
            });
          }}
        >
          <label htmlFor="memory-category">Kind</label>
          <select
            id="memory-category"
            value={category}
            onChange={(event) => {
              // Narrow against the known set rather than asserting: a select
              // value is a string, and trusting it would be trusting the DOM.
              const chosen = CATEGORIES.find(
                ([value]) => value === event.target.value,
              );
              if (chosen) setCategory(chosen[0]);
            }}
          >
            {CATEGORIES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>

          <label htmlFor="memory-content">Remember that…</label>
          <input
            id="memory-content"
            value={content}
            maxLength={500}
            onChange={(event) => setContent(event.target.value)}
            placeholder="I prefer to train in the evening"
          />

          <button className="button" type="submit" disabled={busy}>
            Add
          </button>
        </form>
      </section>

      {memories.length > 0 && (
        <section className="pause-effects" aria-labelledby="assistant-entries">
          <h2 id="assistant-entries">Entries</h2>
          <ul className="memory-list">
            {memories.map((memory) => (
              <li key={memory.id}>
                <span className="memory-kind">{memory.category}</span>
                <span>{memory.content}</span>
                {/* Entries the model proposed are marked, so it is always clear
                    which of these you said and which were inferred. */}
                {memory.author === "assistant" && (
                  <span className="memory-author">suggested by Rafay</span>
                )}
                <button
                  className="text-button"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(() => apiClient.deleteAiMemory(memory.id))
                  }
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
          <button
            className="button button--danger"
            type="button"
            disabled={busy}
            onClick={() => void run(() => apiClient.forgetAllAiMemories())}
          >
            Forget everything
          </button>
        </section>
      )}
    </div>
  );
}

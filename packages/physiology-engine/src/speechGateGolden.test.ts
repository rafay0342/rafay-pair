import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SpeechGate } from "./speechGate.js";

interface Case {
  readonly name: string;
  readonly note: string;
  readonly levels: readonly number[];
  readonly transmit: readonly boolean[];
}

const vectors = JSON.parse(
  readFileSync(
    new URL("../../../tests/golden/speech-gate/vectors.json", import.meta.url),
    "utf8",
  ),
) as { readonly cases: readonly Case[] };

describe("speech gate golden vectors", () => {
  // The same vectors are consumed by the Swift and Kotlin ports. Three
  // independent implementations agreeing on committed data is what parity
  // means here; agreeing on prose is not.
  it.each(vectors.cases.map((entry) => [entry.name, entry] as const))(
    "%s",
    (_name, entry) => {
      const gate = new SpeechGate();
      const actual = entry.levels.map((level) => gate.accept(level).transmit);
      expect(actual, entry.note).toEqual([...entry.transmit]);
    },
  );
});

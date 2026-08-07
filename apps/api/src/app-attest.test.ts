import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createAppAttestClientData, hashAppAttestKeyId } from "./app-attest.js";

describe("App Attest server binding", () => {
  it("reconstructs deterministic, content-bound client data", () => {
    const input = {
      challengeId: "11111111-1111-4111-8111-111111111111",
      action: "session_start",
      mode: "assertion" as const,
      serverChallenge: Buffer.alloc(32, 7),
    };
    const first = createAppAttestClientData(input);
    const second = createAppAttestClientData(input);
    expect(first.equals(second)).toBe(true);
    expect(first.toString("utf8")).toBe(
      [
        "rafaypair.app-attest.v1",
        "POST",
        "/v1/integrity/ios/assessments",
        input.challengeId,
        "session_start",
        "assertion",
        Buffer.alloc(32, 7).toString("base64url"),
      ].join("\n"),
    );
    expect(createHash("sha256").update(first).digest()).toHaveLength(32);
  });

  it("changes when any replay-sensitive component changes", () => {
    const base = {
      challengeId: "11111111-1111-4111-8111-111111111111",
      action: "session_start",
      mode: "assertion" as const,
      serverChallenge: Buffer.alloc(32, 7),
    };
    expect(
      createAppAttestClientData({ ...base, mode: "attestation" }).equals(
        createAppAttestClientData(base),
      ),
    ).toBe(false);
    expect(
      createAppAttestClientData({
        ...base,
        challengeId: "22222222-2222-4222-8222-222222222222",
      }).equals(createAppAttestClientData(base)),
    ).toBe(false);
  });

  it("hashes only canonical 32-byte App Attest key identifiers", () => {
    const keyBytes = Buffer.alloc(32, 3);
    const keyId = keyBytes.toString("base64");
    expect(hashAppAttestKeyId(keyId)).toEqual(
      createHash("sha256").update(keyBytes).digest(),
    );
    expect(() => hashAppAttestKeyId(keyId.replace(/=$/u, ""))).toThrowError(
      "App Attest verification failed",
    );
  });
});

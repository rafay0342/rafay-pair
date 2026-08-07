import { describe, expect, it } from "vitest";

import {
  classifyPlayIntegrityProviderFailure,
  createPlayIntegrityRequestHash,
  evaluatePlayIntegrityResponse,
  type DecodedPlayIntegrityResponse,
} from "./play-integrity.js";

const challengeId = "00000000-0000-4000-8000-000000000123";

describe("Android Play Integrity policy", () => {
  it("uses the cross-platform canonical SHA-256 request binding", () => {
    expect(createPlayIntegrityRequestHash(challengeId, "session_start")).toBe(
      "g6LSFfKKxcAjvDrNb64OCWOe9XAhzZuXPiTD0xYu30s",
    );
  });

  it("treats only a fresh, bound, recognized production verdict as low risk", () => {
    const now = new Date("2026-08-07T12:00:00.000Z");
    const decoded = response({
      timestampMillis: String(now.getTime() - 1_000),
    });
    expect(
      evaluatePlayIntegrityResponse(decoded, {
        packageName: "com.rafaypair.android",
        requestHash: createPlayIntegrityRequestHash(
          challengeId,
          "session_start",
        ),
        now,
        maxTokenAgeMs: 120_000,
        allowedCertificateSha256Digests: ["a".repeat(43)],
        minimumVersionCode: 1,
      }),
    ).toMatchObject({ signal: "low_risk", bindingValid: true });
  });

  it("rejects replay-cleared identity fields and mismatched request hashes", () => {
    const now = new Date("2026-08-07T12:00:00.000Z");
    const expectedRequestHash = createPlayIntegrityRequestHash(
      challengeId,
      "session_start",
    );
    const replayed = response({
      timestampMillis: String(now.getTime()),
      appRecognitionVerdict: "UNEVALUATED",
      appLicensingVerdict: "UNEVALUATED",
      deviceRecognitionVerdict: [],
      omitCertificate: true,
      omitVersion: true,
    });
    expect(
      evaluatePlayIntegrityResponse(replayed, {
        packageName: "com.rafaypair.android",
        requestHash: expectedRequestHash,
        now,
        maxTokenAgeMs: 120_000,
        allowedCertificateSha256Digests: ["a".repeat(43)],
        minimumVersionCode: 1,
      }).signal,
    ).toBe("invalid_binding");
    const mismatched = response({
      timestampMillis: String(now.getTime()),
      requestHash: "different-request-hash",
    });
    expect(
      evaluatePlayIntegrityResponse(mismatched, {
        packageName: "com.rafaypair.android",
        requestHash: expectedRequestHash,
        now,
        maxTokenAgeMs: 120_000,
        allowedCertificateSha256Digests: ["a".repeat(43)],
        minimumVersionCode: 1,
      }),
    ).toMatchObject({ signal: "invalid_binding", bindingValid: false });
  });

  it("requires an allowlisted signer and marks recognized versions below policy as elevated", () => {
    const now = new Date("2026-08-07T12:00:00.000Z");
    const expected = {
      packageName: "com.rafaypair.android",
      requestHash: createPlayIntegrityRequestHash(challengeId, "session_start"),
      now,
      maxTokenAgeMs: 120_000,
      allowedCertificateSha256Digests: ["a".repeat(43)],
      minimumVersionCode: 50,
    } as const;
    expect(
      evaluatePlayIntegrityResponse(
        response({ timestampMillis: String(now.getTime()), versionCode: "42" }),
        expected,
      ),
    ).toMatchObject({ signal: "elevated_risk", bindingValid: true });
    expect(
      evaluatePlayIntegrityResponse(
        response({
          timestampMillis: String(now.getTime()),
          certificateSha256Digest: ["b".repeat(43)],
        }),
        expected,
      ),
    ).toMatchObject({ signal: "invalid_binding", bindingValid: false });
  });

  it("distinguishes rejected tokens from credential, quota, and timeout failures", () => {
    expect(
      classifyPlayIntegrityProviderFailure({
        response: {
          status: 400,
          config: {
            url: "https://playintegrity.googleapis.com/v1/com.rafaypair.android:decodeIntegrityToken",
          },
        },
      }),
    ).toBe("token_rejected");
    expect(
      classifyPlayIntegrityProviderFailure({
        response: {
          status: 400,
          config: { url: "https://oauth2.googleapis.com/token" },
        },
      }),
    ).toBe("credentials_rejected");
    expect(
      classifyPlayIntegrityProviderFailure({ response: { status: 429 } }),
    ).toBe("quota_exhausted");
    expect(classifyPlayIntegrityProviderFailure({ code: "ETIMEDOUT" })).toBe(
      "timeout",
    );
  });
});

function response(overrides: {
  timestampMillis: string;
  requestHash?: string;
  appRecognitionVerdict?: string;
  appLicensingVerdict?: string;
  deviceRecognitionVerdict?: string[];
  certificateSha256Digest?: string[];
  versionCode?: string;
  omitCertificate?: boolean;
  omitVersion?: boolean;
}): DecodedPlayIntegrityResponse {
  return {
    tokenPayloadExternal: {
      requestDetails: {
        requestPackageName: "com.rafaypair.android",
        requestHash:
          overrides.requestHash ??
          createPlayIntegrityRequestHash(challengeId, "session_start"),
        timestampMillis: overrides.timestampMillis,
      },
      appIntegrity: {
        appRecognitionVerdict:
          overrides.appRecognitionVerdict ?? "PLAY_RECOGNIZED",
        packageName: "com.rafaypair.android",
        ...(overrides.omitVersion
          ? {}
          : { versionCode: overrides.versionCode ?? "42" }),
        ...(overrides.omitCertificate
          ? {}
          : {
              certificateSha256Digest: overrides.certificateSha256Digest ?? [
                "a".repeat(43),
              ],
            }),
      },
      accountDetails: {
        appLicensingVerdict: overrides.appLicensingVerdict ?? "LICENSED",
      },
      deviceIntegrity: {
        deviceRecognitionVerdict: overrides.deviceRecognitionVerdict ?? [
          "MEETS_DEVICE_INTEGRITY",
        ],
      },
      testingDetails: { isTestingResponse: false },
    },
  };
}

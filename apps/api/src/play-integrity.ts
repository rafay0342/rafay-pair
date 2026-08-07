import { createHash } from "node:crypto";

import { GoogleAuth, type GoogleAuthOptions } from "google-auth-library";
import { z } from "zod";

import type { AndroidIntegrityAction } from "@rafay-pair/api-contracts";

const playIntegrityScope =
  "https://www.googleapis.com/auth/playintegrity" as const;
const futureTimestampToleranceMilliseconds = 30_000;

const boundedVerdictSchema = z.string().min(1).max(64);
const decodeResponseSchema = z.object({
  tokenPayloadExternal: z.object({
    requestDetails: z.object({
      requestPackageName: z.string().min(1).max(255),
      requestHash: z.string().min(1).max(500),
      timestampMillis: z.string().regex(/^\d{13}$/u),
    }),
    accountDetails: z.object({
      appLicensingVerdict: boundedVerdictSchema,
    }),
    appIntegrity: z.object({
      appRecognitionVerdict: boundedVerdictSchema,
      packageName: z.string().min(1).max(255).optional(),
      versionCode: z
        .string()
        .regex(/^\d{1,19}$/u)
        .optional(),
      certificateSha256Digest: z
        .array(z.string().min(20).max(128))
        .max(8)
        .optional(),
    }),
    deviceIntegrity: z.object({
      deviceRecognitionVerdict: z
        .array(boundedVerdictSchema)
        .max(16)
        .optional(),
    }),
    testingDetails: z
      .object({
        isTestingResponse: z.boolean().optional(),
      })
      .optional(),
  }),
});

export type DecodedPlayIntegrityResponse = z.infer<typeof decodeResponseSchema>;

export interface PlayIntegrityVerifier {
  decode(integrityToken: string): Promise<DecodedPlayIntegrityResponse>;
}

export type PlayIntegrityProviderFailure =
  | "token_rejected"
  | "timeout"
  | "credentials_rejected"
  | "quota_exhausted"
  | "provider_unavailable"
  | "invalid_response";

export class PlayIntegrityProviderError extends Error {
  public constructor(public readonly reason: PlayIntegrityProviderFailure) {
    super("Google Play Integrity verification is temporarily unavailable");
    this.name = "PlayIntegrityProviderError";
  }
}

export class GooglePlayIntegrityVerifier implements PlayIntegrityVerifier {
  private readonly auth: GoogleAuth;

  public constructor(
    private readonly options: {
      packageName: string;
      googleCredentials: Record<string, unknown>;
      timeoutMs: number;
    },
  ) {
    this.auth = new GoogleAuth({
      credentials: options.googleCredentials as NonNullable<
        GoogleAuthOptions["credentials"]
      >,
      scopes: [playIntegrityScope],
    });
  }

  public async decode(
    integrityToken: string,
  ): Promise<DecodedPlayIntegrityResponse> {
    try {
      const response = await withTimeout(
        this.auth.request<unknown>({
          url: `https://playintegrity.googleapis.com/v1/${this.options.packageName}:decodeIntegrityToken`,
          method: "POST",
          data: { integrity_token: integrityToken },
          timeout: this.options.timeoutMs,
          retry: false,
          headers: { "content-type": "application/json" },
        }),
        this.options.timeoutMs,
      );
      const parsed = decodeResponseSchema.safeParse(response.data);
      if (!parsed.success) {
        throw new PlayIntegrityProviderError("invalid_response");
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof PlayIntegrityProviderError) throw error;
      throw new PlayIntegrityProviderError(
        classifyPlayIntegrityProviderFailure(error),
      );
    }
  }
}

export function createPlayIntegrityRequestHash(
  challengeId: string,
  action: AndroidIntegrityAction,
): string {
  const canonical = [
    "rafaypair.play-integrity.v1",
    "POST",
    "/v1/integrity/android/assessments",
    challengeId,
    action,
  ].join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

export function evaluatePlayIntegrityResponse(
  decoded: DecodedPlayIntegrityResponse,
  expected: {
    packageName: string;
    requestHash: string;
    now: Date;
    maxTokenAgeMs: number;
    allowedCertificateSha256Digests: readonly string[];
    minimumVersionCode: number;
  },
): {
  signal: "low_risk" | "elevated_risk" | "invalid_binding";
  bindingValid: boolean;
  metadata: Record<string, unknown>;
} {
  const payload = decoded.tokenPayloadExternal;
  const tokenTimestamp = Number(payload.requestDetails.timestampMillis);
  const ageMilliseconds = expected.now.getTime() - tokenTimestamp;
  const packageBindingValid =
    payload.requestDetails.requestPackageName === expected.packageName &&
    (payload.appIntegrity.packageName === undefined ||
      payload.appIntegrity.packageName === expected.packageName);
  const certificateDigests = [
    ...(payload.appIntegrity.certificateSha256Digest ?? []),
  ].sort();
  const allowedCertificateDigests = new Set(
    expected.allowedCertificateSha256Digests,
  );
  const certificateBindingValid =
    certificateDigests.length > 0 &&
    certificateDigests.every((digest) => allowedCertificateDigests.has(digest));
  const versionCode = payload.appIntegrity.versionCode
    ? BigInt(payload.appIntegrity.versionCode)
    : undefined;
  const versionPresent =
    versionCode !== undefined &&
    versionCode >= 1n &&
    versionCode <= 2_100_000_000n;
  const versionSupported =
    versionPresent && versionCode >= BigInt(expected.minimumVersionCode);
  const bindingValid =
    packageBindingValid &&
    certificateBindingValid &&
    versionPresent &&
    payload.requestDetails.requestHash === expected.requestHash &&
    Number.isSafeInteger(tokenTimestamp) &&
    ageMilliseconds >= -futureTimestampToleranceMilliseconds &&
    ageMilliseconds <= expected.maxTokenAgeMs;
  const deviceVerdicts = [
    ...(payload.deviceIntegrity.deviceRecognitionVerdict ?? []),
  ].sort();
  const testingResponse = payload.testingDetails?.isTestingResponse === true;
  const lowRisk =
    bindingValid &&
    !testingResponse &&
    payload.appIntegrity.appRecognitionVerdict === "PLAY_RECOGNIZED" &&
    payload.accountDetails.appLicensingVerdict === "LICENSED" &&
    versionSupported &&
    deviceVerdicts.includes("MEETS_DEVICE_INTEGRITY");
  return {
    signal: bindingValid
      ? lowRisk
        ? "low_risk"
        : "elevated_risk"
      : "invalid_binding",
    bindingValid,
    metadata: {
      appRecognitionVerdict: payload.appIntegrity.appRecognitionVerdict,
      appLicensingVerdict: payload.accountDetails.appLicensingVerdict,
      deviceRecognitionVerdicts: deviceVerdicts,
      testingResponse,
      certificateAllowlistMatch: certificateBindingValid,
      versionSupported,
      ...(payload.appIntegrity.versionCode
        ? { appVersionCode: payload.appIntegrity.versionCode }
        : {}),
      tokenRequestedAt: new Date(tokenTimestamp).toISOString(),
    },
  };
}

export function classifyPlayIntegrityProviderFailure(
  error: unknown,
): PlayIntegrityProviderFailure {
  if (
    (error instanceof Error && error.message === "provider timeout") ||
    providerErrorCode(error) === "ETIMEDOUT" ||
    providerErrorCode(error) === "ECONNABORTED"
  ) {
    return "timeout";
  }
  const status = providerHttpStatus(error);
  if (status === 400) {
    return providerRequestHost(error) === "playintegrity.googleapis.com"
      ? "token_rejected"
      : "credentials_rejected";
  }
  if (status === 401 || status === 403) {
    return "credentials_rejected";
  }
  if (status === 429) return "quota_exhausted";
  return "provider_unavailable";
}

function providerErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function providerRequestHost(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const directConfig = (error as { config?: unknown }).config;
  const response = (error as { response?: unknown }).response;
  const responseConfig =
    response && typeof response === "object"
      ? (response as { config?: unknown }).config
      : undefined;
  for (const config of [directConfig, responseConfig]) {
    if (!config || typeof config !== "object") continue;
    const url = (config as { url?: unknown }).url;
    if (typeof url !== "string") continue;
    try {
      return new URL(url).hostname;
    } catch {
      // A malformed provider URL is not trusted as a token-rejection response.
    }
  }
  return undefined;
}

function providerHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== "object") return undefined;
  const status = (response as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("provider timeout")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

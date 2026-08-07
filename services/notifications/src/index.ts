import * as http2 from "node:http2";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import { importPKCS8, SignJWT } from "jose";

export interface NotificationDevice {
  id: string;
  platform: "ios" | "android";
  token: string;
}

export interface CarePushNotification {
  eventId: string;
  careRequestId: string;
  kind: string;
}

export interface NotificationResult {
  providerMessageId?: string;
}

export interface PushProvider {
  send(
    device: NotificationDevice,
    notification: CarePushNotification,
  ): Promise<NotificationResult>;
}

export interface ApnsConfiguration {
  teamId: string;
  keyId: string;
  bundleId: string;
  privateKey: string;
  environment: "sandbox" | "production";
}

export interface FcmConfiguration {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export class NotificationConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NotificationConfigurationError";
  }
}

export class NotificationDeliveryError extends Error {
  public constructor(
    message: string,
    public readonly permanent: boolean,
    public readonly providerStatus?: number,
    public readonly invalidateDevice = false,
  ) {
    super(message);
    this.name = "NotificationDeliveryError";
  }
}

export class NotificationDispatcher {
  public constructor(
    private readonly apns?: PushProvider,
    private readonly fcm?: PushProvider,
  ) {}

  public async send(
    device: NotificationDevice,
    notification: CarePushNotification,
  ): Promise<NotificationResult> {
    const provider = device.platform === "ios" ? this.apns : this.fcm;
    if (!provider) {
      throw new NotificationConfigurationError(
        `Push provider is not configured for ${device.platform}`,
      );
    }
    return provider.send(device, notification);
  }
}

export class ApnsProvider implements PushProvider {
  private signingKey?: Awaited<ReturnType<typeof importPKCS8>>;
  private cachedJwt: { value: string; createdAt: number } | undefined;

  public constructor(private readonly configuration: ApnsConfiguration) {}

  public async send(
    device: NotificationDevice,
    notification: CarePushNotification,
  ): Promise<NotificationResult> {
    if (device.platform !== "ios")
      throw new Error("APNs can only send to iOS devices");
    const authority =
      this.configuration.environment === "production"
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com";
    const jwt = await this.providerJwt();
    const body = contentlessApnsCareSyncPayload();

    return new Promise((resolve, reject) => {
      const client = http2.connect(authority);
      client.once("error", reject);
      client.setTimeout(10_000, () => {
        client.destroy();
        reject(new NotificationDeliveryError("APNs request timed out", false));
      });
      const request = client.request({
        [http2.constants.HTTP2_HEADER_METHOD]: "POST",
        [http2.constants.HTTP2_HEADER_PATH]:
          `/3/device/${encodeURIComponent(device.token)}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": this.configuration.bundleId,
        "apns-push-type": "background",
        "apns-priority": "5",
        "apns-expiration": "0",
        "apns-collapse-id": "rafaypair-care-sync",
        "apns-id": notification.eventId,
        "content-type": "application/json",
      });
      let status = 0;
      let responseBody = "";
      request.setEncoding("utf8");
      request.on("response", (headers) => {
        status = Number(headers[http2.constants.HTTP2_HEADER_STATUS] ?? 0);
      });
      request.on("data", (chunk: string) => {
        responseBody += chunk;
      });
      request.once("error", (error) => {
        client.close();
        reject(error);
      });
      request.once("end", () => {
        client.close();
        if (status === 200) {
          resolve({});
          return;
        }
        const classification = classifyApnsFailure(status, responseBody);
        if (classification.reason === "ExpiredProviderToken") {
          this.cachedJwt = undefined;
        }
        reject(
          new NotificationDeliveryError(
            `APNs rejected notification (${classification.reason ?? `HTTP ${String(status)}`})`,
            classification.permanent,
            status,
            classification.invalidateDevice,
          ),
        );
      });
      request.end(body);
    });
  }

  private async providerJwt(): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    if (this.cachedJwt && now - this.cachedJwt.createdAt < 3_000)
      return this.cachedJwt.value;
    this.signingKey ??= await importPKCS8(
      normalizePrivateKey(this.configuration.privateKey),
      "ES256",
    );
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.configuration.keyId })
      .setIssuer(this.configuration.teamId)
      .setIssuedAt(now)
      .sign(this.signingKey);
    this.cachedJwt = { value, createdAt: now };
    return value;
  }
}

export class FcmProvider implements PushProvider {
  private cachedAccessToken?: { value: string; expiresAt: number };

  public constructor(private readonly configuration: FcmConfiguration) {}

  public async send(
    device: NotificationDevice,
    _notification: CarePushNotification,
  ): Promise<NotificationResult> {
    if (device.platform !== "android")
      throw new Error("FCM can only send to Android devices");
    const accessToken = await this.accessToken();
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.configuration.projectId)}/messages:send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(contentlessFcmCareSyncMessage(device.token)),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const payload = (await response.json().catch(() => ({}))) as {
      name?: string;
      error?: unknown;
    };
    if (!response.ok) {
      const classification = classifyFcmFailure(response.status, payload);
      throw new NotificationDeliveryError(
        `FCM rejected notification (${classification.code ?? `HTTP ${String(response.status)}`})`,
        classification.permanent,
        response.status,
        classification.invalidateDevice,
      );
    }
    return payload.name ? { providerMessageId: payload.name } : {};
  }

  private async accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    if (this.cachedAccessToken && this.cachedAccessToken.expiresAt - 60 > now) {
      return this.cachedAccessToken.value;
    }
    const key = await importPKCS8(
      normalizePrivateKey(this.configuration.privateKey),
      "RS256",
    );
    const assertion = await new SignJWT({
      scope: "https://www.googleapis.com/auth/firebase.messaging",
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.configuration.clientEmail)
      .setSubject(this.configuration.clientEmail)
      .setAudience("https://oauth2.googleapis.com/token")
      .setIssuedAt(now)
      .setExpirationTime(now + 3_600)
      .sign(key);
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!response.ok || !payload.access_token) {
      throw new NotificationDeliveryError(
        payload.error ?? "FCM OAuth failed",
        false,
        response.status,
      );
    }
    this.cachedAccessToken = {
      value: payload.access_token,
      expiresAt: now + (payload.expires_in ?? 3_600),
    };
    return payload.access_token;
  }
}

export function contentlessApnsCareSyncPayload(): string {
  return JSON.stringify({ aps: { "content-available": 1 } });
}

export function contentlessFcmCareSyncMessage(firebaseInstallationId: string) {
  return {
    message: {
      fid: firebaseInstallationId,
      data: { sync: "care" },
      android: {
        priority: "high",
        ttl: "0s",
        collapse_key: "rafaypair-care-sync",
      },
    },
  } as const;
}

export interface ProviderFailureClassification {
  permanent: boolean;
  invalidateDevice: boolean;
  reason?: string;
  code?: string;
}

export function classifyApnsFailure(
  status: number,
  responseBody: string,
): ProviderFailureClassification {
  let reason: string | undefined;
  try {
    const parsed = JSON.parse(responseBody) as { reason?: unknown };
    if (typeof parsed.reason === "string" && parsed.reason.length <= 128) {
      reason = parsed.reason;
    }
  } catch {
    // Status-based fallback remains safe and never logs the provider body.
  }
  const invalidateDevice =
    status === 410 && (reason === "ExpiredToken" || reason === "Unregistered");
  const transientReason =
    reason === "ExpiredProviderToken" ||
    reason === "TooManyProviderTokenUpdates" ||
    reason === "TooManyRequests" ||
    reason === "InternalServerError" ||
    reason === "ServiceUnavailable" ||
    reason === "Shutdown";
  return {
    permanent: !transientReason && status >= 400 && status < 500,
    invalidateDevice,
    ...(reason ? { reason } : {}),
  };
}

export function classifyFcmFailure(
  status: number,
  payload: unknown,
): ProviderFailureClassification {
  const code = extractFcmErrorCode(payload);
  const invalidateDevice =
    code === "UNREGISTERED" || code === "INVALID_ARGUMENT";
  const transient =
    status === 429 ||
    status >= 500 ||
    code === "QUOTA_EXCEEDED" ||
    code === "UNAVAILABLE" ||
    code === "INTERNAL";
  return {
    permanent: !transient && status >= 400 && status < 500,
    invalidateDevice,
    ...(code ? { code } : {}),
  };
}

function extractFcmErrorCode(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.error)) return undefined;
  const details = payload.error.details;
  if (!Array.isArray(details)) return undefined;
  for (const detail of details) {
    if (
      isRecord(detail) &&
      detail["@type"] ===
        "type.googleapis.com/google.firebase.fcm.v1.FcmError" &&
      typeof detail.errorCode === "string" &&
      /^[A-Z_]{2,64}$/u.test(detail.errorCode)
    ) {
      return detail.errorCode;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePrivateKey(value: string): string {
  return value.replaceAll("\\n", "\n");
}

export function deriveDeviceEncryptionKey(
  sessionPepper: string,
  configuredKey?: string,
): string {
  return (
    configuredKey ??
    createHash("sha256")
      .update("rafay-pair:device-token:")
      .update(sessionPepper)
      .digest("base64url")
  );
}

export function encryptDeviceToken(value: string, encodedKey: string): string {
  const key = decodeEncryptionKey(encodedKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    "base64url",
  );
}

export function decryptDeviceToken(value: string, encodedKey: string): string {
  const key = decodeEncryptionKey(encodedKey);
  const data = Buffer.from(value, "base64url");
  if (data.length < 29) throw new Error("Encrypted device token is malformed");
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([
    decipher.update(data.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}

function decodeEncryptionKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, "base64url");
  if (key.length !== 32)
    throw new Error("Device token encryption key must decode to 32 bytes");
  return key;
}

import { describe, expect, it, vi } from "vitest";

import {
  classifyApnsFailure,
  classifyFcmFailure,
  NotificationConfigurationError,
  NotificationDispatcher,
  contentlessApnsCareSyncPayload,
  contentlessFcmCareSyncMessage,
  type PushProvider,
} from "./index.js";

describe("NotificationDispatcher", () => {
  it("routes devices only to their configured provider", async () => {
    const send = vi
      .fn<PushProvider["send"]>()
      .mockResolvedValue({ providerMessageId: "message-1" });
    const dispatcher = new NotificationDispatcher({ send });
    const result = await dispatcher.send(
      {
        id: crypto.randomUUID(),
        platform: "ios",
        token: "device-token-long-enough",
      },
      {
        eventId: crypto.randomUUID(),
        careRequestId: crypto.randomUUID(),
        kind: "check_in",
      },
    );
    expect(result.providerMessageId).toBe("message-1");
  });

  it("fails closed when credentials for a device platform are absent", async () => {
    const dispatcher = new NotificationDispatcher();
    await expect(
      dispatcher.send(
        {
          id: crypto.randomUUID(),
          platform: "android",
          token: "device-token-long-enough",
        },
        {
          eventId: crypto.randomUUID(),
          careRequestId: crypto.randomUUID(),
          kind: "help",
        },
      ),
    ).rejects.toBeInstanceOf(NotificationConfigurationError);
  });

  it("builds an identifier-free APNs background sync payload", () => {
    const payload = contentlessApnsCareSyncPayload();
    expect(JSON.parse(payload)).toEqual({
      aps: { "content-available": 1 },
    });
    expect(payload).not.toMatch(/careRequestId|eventId|kind|alert|sound/u);
  });

  it("builds an immediate-only, collapsible FCM sync message", () => {
    const payload = contentlessFcmCareSyncMessage("installation-token");
    expect(payload.message).toMatchObject({
      fid: "installation-token",
      data: { sync: "care" },
      android: { ttl: "0s", collapse_key: "rafaypair-care-sync" },
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /careRequestId|eventId|kind|notification|body|title/u,
    );
  });

  it("invalidates only APNs registrations proven inactive", () => {
    expect(
      classifyApnsFailure(410, JSON.stringify({ reason: "Unregistered" })),
    ).toMatchObject({ permanent: true, invalidateDevice: true });
    expect(
      classifyApnsFailure(400, JSON.stringify({ reason: "BadDeviceToken" })),
    ).toMatchObject({ permanent: true, invalidateDevice: false });
    expect(
      classifyApnsFailure(
        403,
        JSON.stringify({ reason: "ExpiredProviderToken" }),
      ),
    ).toMatchObject({ permanent: false, invalidateDevice: false });
    expect(
      classifyApnsFailure(503, JSON.stringify({ reason: "Shutdown" })),
    ).toMatchObject({ permanent: false, invalidateDevice: false });
  });

  it("uses FCM detail codes instead of destructive HTTP-status guesses", () => {
    const fcmError = (errorCode: string) => ({
      error: {
        details: [
          {
            "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
            errorCode,
          },
        ],
      },
    });
    expect(classifyFcmFailure(404, fcmError("UNREGISTERED"))).toMatchObject({
      permanent: true,
      invalidateDevice: true,
    });
    expect(classifyFcmFailure(400, fcmError("INVALID_ARGUMENT"))).toMatchObject(
      { permanent: true, invalidateDevice: true },
    );
    expect(
      classifyFcmFailure(403, fcmError("SENDER_ID_MISMATCH")),
    ).toMatchObject({ permanent: true, invalidateDevice: false });
    expect(classifyFcmFailure(503, fcmError("UNAVAILABLE"))).toMatchObject({
      permanent: false,
      invalidateDevice: false,
    });
  });
});

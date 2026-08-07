/// <reference lib="webworker" />

import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { CacheFirst, NetworkFirst } from "workbox-strategies";

declare let self: ServiceWorkerGlobalScope & {
  readonly __WB_MANIFEST: readonly {
    readonly revision?: string;
    readonly url: string;
  }[];
};

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

registerRoute(
  ({ request, url }) =>
    request.mode === "navigate" &&
    url.origin === self.location.origin &&
    !url.pathname.startsWith("/api/"),
  new NetworkFirst({
    cacheName: "rafaypair-navigation-v1",
    networkTimeoutSeconds: 4,
  }),
);

/**
 * The pose model and its runtime are large, immutable, and versioned by path.
 * Precaching them would make the first install download tens of megabytes, so
 * they are cached on first use instead — which is what actually delivers the
 * offline promise, because a workout that has run once keeps working with no
 * network and with no request leaving the device.
 */
registerRoute(
  ({ url }) =>
    url.origin === self.location.origin &&
    url.pathname.startsWith("/models/mediapipe/"),
  new CacheFirst({ cacheName: "rafaypair-pose-model-v1" }),
);

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") void self.skipWaiting();
});

clientsClaim();

export {};

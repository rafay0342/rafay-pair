/// <reference lib="webworker" />

import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { NetworkFirst } from "workbox-strategies";

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

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") void self.skipWaiting();
});

clientsClaim();

export {};

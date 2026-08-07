# RafayPair Web / PWA

Independent React 19 + strict TypeScript browser client for the RafayPair Milestone 1 contract.

## Runtime configuration

`VITE_API_BASE_URL` is the only browser API setting. It is public configuration, never a secret.

- Development defaults to `http://localhost:3000`.
- Production defaults to the current Web origin. The edge must route `/v1/*` to the API service without changing the path, forward required headers/cookies/query strings, disable caching, and preserve WebSocket upgrades. `Sec-WebSocket-Protocol` must reach the API but be excluded from logs; one-time tickets never appear in URLs and the API selects only `rafaypair.v1`.
- Cookie deployments must stay same-site. The production same-origin route lets JavaScript read only the non-HttpOnly `rafay_csrf` double-submit cookie while access and refresh credentials remain HttpOnly.

Qwen/provider master credentials never enter this package or a `VITE_*` variable.

## Verification

From the repository root:

```sh
pnpm --filter @rafay-pair/web typecheck
pnpm --filter @rafay-pair/web lint
pnpm --filter @rafay-pair/web test
pnpm --filter @rafay-pair/web build
```

The build extracts hidden source maps to ignored `private-source-maps/`, verifies bundle budgets and SRI, and leaves only deployable files in `dist/`.

## Live Playwright E2E

The E2E suite never intercepts or mocks API routes. With PostgreSQL and Redis on their local default ports, this command migrates and starts the real API plus Vite, then runs Chromium and mobile Safari projects:

```sh
pnpm --filter @rafay-pair/web test:e2e
```

Use `RAFAYPAIR_E2E_API_URL` when the API is already running, or `RAFAYPAIR_E2E_BASE_URL` to test an already deployed web release.

## Deployment contract

- Serve `index.html`, `manifest.webmanifest`, and `service-worker.js` with no-cache or no-store.
- Serve content-hashed `/assets/*` immutably.
- Apply [`public/_headers`](public/_headers) or equivalent headers from [`deploy/nginx.conf`](deploy/nginx.conf).
- Preserve SPA history fallback without routing `/v1/*` to `index.html` or converting API errors into successful HTML responses.
- Store `private-source-maps/` only in protected error-monitoring storage.
- Deploy atomically by version so the previous immutable bundle can be restored.

The service worker waits for explicit user approval before activating an update. It never caches API responses and stores no authentication or health data. IndexedDB contains only message-free, non-urgent care drafts. Their kind is AES-GCM encrypted with a non-exportable Web Crypto key, every record is bound to the authenticated user and active pair, and legacy unscoped records are discarded. Drafts are deleted after server-side consent-checked delivery, invalid session detection, pair disconnect, or sign-out.

A user/pair-scoped privacy-pause intent is persisted before the network mutation. Reloads and other tabs remain fail closed, realtime stays disconnected, and queued care remains blocked until the server confirms pause or the user explicitly completes a server-confirmed resume.

# On-device pose model assets

This directory holds the MediaPipe runtime and the BlazePose model that the Web
client uses to detect body position locally. They are multi-megabyte binaries, so
they belong to the build rather than to the source history and are not committed.

**Nothing needs to be done by hand.** `pnpm --filter @rafay-pair/web build` and
`dev` both run `scripts/fetch-pose-model.mjs` first, which copies the runtime out
of the installed npm package and downloads the model, verifying its SHA-256
against the pinned digest. Running it again is a no-op once the assets are there.

To fetch them explicitly:

```bash
pnpm --filter @rafay-pair/web models
```

Self-hosting is required rather than optional: loading the runtime from a
third-party CDN would leak a request on every workout and would break the offline
promise of the installed PWA.

If the assets are missing — no network during a build, for instance — the build
still succeeds and the Move page reports that local pose is unavailable. It never
falls back to sending video to a server; there is no such path in the client.

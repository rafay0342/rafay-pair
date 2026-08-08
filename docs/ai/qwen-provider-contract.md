# Backend-only Qwen provider contract

Implemented in Gate 4. `apps/api/src/ai/provider.ts` reads these values and nothing else does; `apps/api/src/routes/ai-voice-routes.ts` is the only place the provider is opened. When they are absent the deployment reports voice unavailable and refuses to open a socket rather than returning plausible audio.

There are two shapes of Model Studio key, and which one you have decides the endpoint. A **workspace key** works against `<workspace>.<region>.maas.aliyuncs.com`; set `QWEN_WORKSPACE_ID` to the identifier in that host. A key for the **shared international endpoint** works against `dashscope-intl.aliyuncs.com`; leave `QWEN_WORKSPACE_ID` empty. Each host refuses the other's key, so this is a property of how the key was issued rather than a deployment preference. The server reaches those two hosts and no others: both are fixed strings in `qwenEndpoint`, so configuration chooses between two destinations and cannot invent a third.

To obtain a workspace key: create an Alibaba Cloud Model Studio workspace in the Singapore (`ap-southeast-1`) region, generate a Model Studio API key inside that workspace, and copy the workspace identifier out of its endpoint host. A workspace-scoped key (`sk-ws-…`) works; so does the workspace id embedded in the International endpoint, for example `ws-xq02xlvg2ivc6oyc` in `https://ws-xq02xlvg2ivc6oyc.ap-southeast-1.maas.aliyuncs.com/…`. Only `DASHSCOPE_API_KEY` is secret; the model and region are fixed allowlisted strings that the server refuses to accept any other value for.

`pnpm run check:ai` walks the chain and names the actual cause. Run that before
concluding anything about voice, because the failures below look identical from
the application's side and need different people to fix them.

**Activation is separate from the key, and standing is separate from both.** A key can authenticate — `GET /compatible-mode/v1/models` returns the full catalogue including `qwen3.5-omni-plus-realtime` — and still be entitled to no model at all. Using one then fails with `AccessDenied.Unpurchased` over HTTP, or a WebSocket close of `1007 Access to model denied` on the realtime endpoint. Model Studio has to be activated for the workspace before any model, paid or free-trial, can be called. Listing a model is not entitlement to it, so a deployment check that only lists models would report a working provider that cannot answer.

`AccessDenied.Unpurchased` on a workspace host has a third cause worth knowing, beyond activation and standing: the key may simply belong to the other endpoint. Trying the shared host with the same key distinguishes it in one request, which is why `scripts/check-ai-provider.mjs` does.

Activation is still not enough. An account in arrears is refused as well, and **free-trial quota is withheld too** — the free tier does not bypass account standing. The workspace endpoint reports both cases as `AccessDenied.Unpurchased`; the shared international endpoint distinguishes them by returning `Arrearage` for the second. `scripts/check-ai-provider.mjs` asks both for that reason, so the answer says whether to activate a service or to settle a balance.

## Configuration

| Name                  | Classification          | Planned validation and use                                                                                                                                                                              |
| --------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DASHSCOPE_API_KEY`   | Secret                  | Non-empty Model Studio API key injected only into the future backend broker from the deployment secret manager. Never returned by an API, logged, persisted in application data, or placed in a client. |
| `QWEN_REALTIME_MODEL` | Non-secret              | Exact allowlisted value `qwen3.5-omni-plus-realtime`; no caller-selected model and no fallback model.                                                                                                   |
| `QWEN_REGION`         | Non-secret              | Exact allowlisted value `ap-southeast-1`; the API key and workspace must belong to the same region.                                                                                                     |
| `QWEN_WORKSPACE_ID`   | Sensitive configuration | Non-empty workspace identifier injected into the future backend broker. Do not expose it in client configuration or telemetry.                                                                          |

The future broker derives the provider URL from the validated workspace, region, and fixed path:

```text
wss://{workspace}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime
```

An arbitrary base URL is intentionally absent. This prevents configuration from becoming an unrestricted server-side egress target. The model is supplied as the provider's `model` query parameter only after exact allowlist validation.

## Security boundary

- Only the future server broker may read `DASHSCOPE_API_KEY` or open the provider WebSocket.
- iOS, Android, Web, service workers, WebAssembly, public build variables, API responses, and source maps must contain none of the four configuration values.
- The broker must fail closed if any required value is absent, malformed, mismatched by region, or unavailable from the secret manager.
- The deployment role may read only the environment-specific Qwen secret. Human access, rotations, and emergency revocation must be audited.
- Authorization headers, audio, transcripts, prompts, tool arguments, physiological context, workspace identifiers, and provider response bodies must not enter ordinary logs.
- Egress is restricted to the derived TLS endpoint. Redirects, caller-provided endpoints, and insecure WebSocket transport are rejected.

Model Studio documents temporary API keys for untrusted environments. RafayPair does not issue them during Gate 1 and does not treat them as authorization. Any future direct transport requires a separately reviewed server exchange that binds a short lifetime and the narrowest available provider scope to the authenticated RafayPair user/session. The backend must still authorize context and tools; if those guarantees cannot be enforced, all media remains brokered.

## Gate 4 activation prerequisites

Runtime implementation may begin only after the preceding native binary gates close and must include:

- explicit generated-voice disclosure and visible microphone state;
- durable consent and privacy-pause checks before every partner-context release;
- schema-validated, allowlisted tool calls with fresh authorization and confirmation for mutations;
- bounded session duration, reconnect/context-compaction behavior, quotas, and abuse controls;
- redaction, audit metadata, incident response, credential rotation, and provider outage handling;
- contract, policy, security, load, reconnect, and native-device tests with no mocked production path.

Provider documentation used for this contract:

- [Qwen-Omni-Realtime](https://www.alibabacloud.com/help/en/model-studio/realtime)
- [Model Studio regions and access domains](https://www.alibabacloud.com/help/en/model-studio/regions/)
- [Generate a temporary API key](https://www.alibabacloud.com/help/en/model-studio/application-obtain-temporary-authentication-token)
- [Realtime token authentication](https://www.alibabacloud.com/help/en/model-studio/realtime-token-authentication)

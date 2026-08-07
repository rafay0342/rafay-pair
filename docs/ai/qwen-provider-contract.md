# Backend-only Qwen provider contract

This is a planning contract for Phase E / the fourth native binary milestone. Gate 1 does not load these values and exposes no AI runtime route. Adding the variables to a developer environment does not enable AI.

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

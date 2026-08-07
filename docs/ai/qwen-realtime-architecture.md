# Qwen realtime architecture

This is the planned Phase E / fourth-milestone architecture. Gate 1 exposes no AI runtime. RafayPair selects Alibaba Cloud Model Studio Qwen as its exclusive AI provider and plans to use `qwen3.5-omni-plus-realtime` in the Singapore region. The production endpoint is workspace-specific. `DASHSCOPE_API_KEY` exists only in the backend secret manager.

Qwen realtime WebSocket and WebRTC connections authenticate during connection establishment. Model Studio also documents short-lived temporary API keys, but those credentials inherit the issuing key's permissions and are not RafayPair authorization. RafayPair therefore keeps an authenticated backend WebSocket broker as the universal authorization and tool boundary. The broker validates audio/event shape, rate limits sessions, filters consent-approved context, meters usage, handles interruption, and forwards Qwen events. A future direct media transport may be enabled only after the earlier delivery gates close, with a server-issued short-lived credential and a design that cannot bypass backend context or tool authorization; otherwise it remains disabled.

Function-call arguments are accepted only from the provider's complete `response.function_call_arguments.done` event. The broker validates the JSON Schema, checks the tool allowlist and current user/pair/consent revision, requires user confirmation for mutations, enforces idempotency, executes the operation on the server, and returns a bounded result tied to the original call ID. Qwen never receives database credentials or direct network access to RafayPair services.

Input audio is 16 kHz 16-bit mono PCM and output is 24 kHz 16-bit mono PCM. Sessions reconnect before the provider's 120-minute maximum. RafayPair compacts and reseeds safe context before Qwen's retained-audio turn/time limits evict earlier state. Generated voice identifies itself as Rafay AI at session start, and language about physiological values preserves source, estimate kind, confidence, and measurement time.

The backend-only environment and secret rules are defined in the [Qwen provider contract](./qwen-provider-contract.md). No provider SDK or compatibility client is added during Gate 1.

Primary provider references:

- https://www.alibabacloud.com/help/en/model-studio/realtime
- https://www.alibabacloud.com/help/en/model-studio/client-events
- https://www.alibabacloud.com/help/en/model-studio/server-events
- https://www.alibabacloud.com/help/en/model-studio/realtime-token-authentication
- https://www.alibabacloud.com/help/en/model-studio/qwen-function-calling
- https://www.alibabacloud.com/help/en/model-studio/regions/
- https://www.alibabacloud.com/help/en/model-studio/rate-limit

import { describe, expect, it } from "vitest";

import {
  providerFromEnvironment,
  qwenCredentialsFromEnvironment,
  qwenEndpoint,
} from "./provider.js";

const valid = {
  DASHSCOPE_API_KEY: "sk-example-key-value",
  QWEN_REALTIME_MODEL: "qwen3.5-omni-plus-realtime",
  QWEN_REGION: "ap-southeast-1",
  QWEN_WORKSPACE_ID: "llm-workspace-01",
} satisfies NodeJS.ProcessEnv;

describe("Qwen credentials", () => {
  it("accepts a complete, allowlisted configuration", () => {
    const credentials = qwenCredentialsFromEnvironment(valid);
    expect(credentials).toBeDefined();
    expect(credentials?.workspaceId).toBe("llm-workspace-01");
  });

  it("returns nothing when any value is absent", () => {
    for (const key of Object.keys(valid)) {
      const partial = { ...valid, [key]: "" };
      expect(qwenCredentialsFromEnvironment(partial), key).toBeUndefined();
    }
  });

  it("refuses a model or region outside the allowlist", () => {
    // Free-form configuration here would turn deployment config into an
    // unrestricted server-side egress target.
    expect(
      qwenCredentialsFromEnvironment({
        ...valid,
        QWEN_REALTIME_MODEL: "gpt-4o",
      }),
    ).toBeUndefined();
    expect(
      qwenCredentialsFromEnvironment({ ...valid, QWEN_REGION: "us-east-1" }),
    ).toBeUndefined();
  });

  it("refuses a workspace identifier that could reshape the endpoint", () => {
    for (const workspace of [
      "has spaces",
      "evil.example.com",
      "../escape",
      "a",
      "workspace/../..",
    ]) {
      expect(
        qwenCredentialsFromEnvironment({
          ...valid,
          QWEN_WORKSPACE_ID: workspace,
        }),
        workspace,
      ).toBeUndefined();
    }
  });

  it("derives the endpoint from validated parts rather than accepting one", () => {
    const credentials = qwenCredentialsFromEnvironment(valid);
    expect(credentials).toBeDefined();
    if (!credentials) return;
    const endpoint = qwenEndpoint(credentials);
    expect(endpoint).toBe(
      "wss://llm-workspace-01.ap-southeast-1.maas.aliyuncs.com" +
        "/api-ws/v1/realtime?model=qwen3.5-omni-plus-realtime",
    );
    // Transport is TLS-only; there is no configuration path to plain ws://.
    expect(endpoint.startsWith("wss://")).toBe(true);
  });
});

describe("provider selection", () => {
  it("is unavailable, and refuses to open, when nothing is configured", async () => {
    const provider = providerFromEnvironment({});
    expect(provider.available).toBe(false);
    // A stub that produced plausible audio would make an unconfigured
    // deployment look functional, which is the one failure mode a voice feature
    // must not have.
    await expect(
      provider.open({ instructions: "", tools: [] }, () => undefined),
    ).rejects.toThrow(/No realtime AI provider/u);
  });

  it("selects the Qwen transport when credentials validate", () => {
    const provider = providerFromEnvironment(valid);
    expect(provider.name).toBe("qwen-omni-realtime");
    expect(provider.available).toBe(true);
  });

  it("does not expose the key through the provider it builds", () => {
    const provider = providerFromEnvironment(valid);
    // The credential lives in one module and is never surfaced on the object a
    // caller holds.
    expect(JSON.stringify(provider)).not.toContain(valid.DASHSCOPE_API_KEY);
  });
});

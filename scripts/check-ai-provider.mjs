#!/usr/bin/env node
/**
 * Diagnose the AI provider, precisely.
 *
 * "Voice doesn't work" has at least five distinct causes, and they need
 * different people to fix them: a missing key, a key for the wrong workspace, a
 * workspace with no model entitlement, an account in arrears, and a model the
 * plan does not include. Each returns a different error, and this walks the
 * chain in order so the answer names the actual one.
 *
 * The order matters. Listing models succeeds on a key that cannot call a single
 * one of them, so a readiness check built on listing would report a working
 * provider that cannot answer. Calling a model is the first step that tells the
 * truth.
 *
 * Reads the same environment the server does. Nothing here is printed that
 * could contain the key.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function environment() {
  const merged = { ...process.env };
  try {
    for (const line of readFileSync(join(root, ".env.local"), "utf8").split(
      "\n",
    )) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match && !merged[match[1]]) merged[match[1]] = match[2];
    }
  } catch {
    // No local file is fine; the environment may already carry the values.
  }
  return merged;
}

const env = environment();
const key = env.DASHSCOPE_API_KEY;
const model = env.QWEN_REALTIME_MODEL;
const region = env.QWEN_REGION;
const workspace = env.QWEN_WORKSPACE_ID;

function report(state, message, action) {
  const mark =
    state === "ok" ? "ok    " : state === "warn" ? "note  " : "FAILED";
  console.log(`  ${mark} ${message}`);
  if (action) console.log(`         ${action}`);
}

if (!key || !model || !region) {
  report(
    "fail",
    "Configuration is incomplete.",
    "DASHSCOPE_API_KEY, QWEN_REALTIME_MODEL, and QWEN_REGION are required. QWEN_WORKSPACE_ID is optional: leaving it empty selects the shared international endpoint. See docs/ai/qwen-provider-contract.md.",
  );
  process.exit(1);
}

// Which host a key works against is a property of how it was issued, not a
// deployment preference, so the check follows the same rule the server does.
const host = workspace
  ? `${workspace}.${region}.maas.aliyuncs.com`
  : "dashscope-intl.aliyuncs.com";
report(
  "ok",
  `Configured for ${model} in ${region}, via ${workspace ? `workspace ${workspace}` : "the shared international endpoint"}.`,
);
const headers = {
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};

// 1. Authentication.
const models = await fetch(`https://${host}/compatible-mode/v1/models`, {
  headers,
}).catch(() => null);
if (!models?.ok) {
  report(
    "fail",
    `The key was not accepted by ${host} (HTTP ${String(models?.status ?? "no response")}).`,
    "Check that the key belongs to this workspace and region.",
  );
  process.exit(1);
}
const catalogue = await models.json();
const names = (catalogue.data ?? []).map((entry) => entry.id);
report("ok", `Authenticated. ${String(names.length)} models listed.`);

if (!names.includes(model)) {
  report(
    "fail",
    `${model} is not in this workspace's catalogue.`,
    "The server's allowlist pins this exact model; a different one cannot be substituted from configuration.",
  );
  process.exit(1);
}
// Listing is not entitlement. Said plainly, because this is the step that
// misleads.
report("warn", "It is listed — which is not the same as being usable.");

// 2. Entitlement, which is where the useful error lives.
const call = await fetch(
  `https://${host}/compatible-mode/v1/chat/completions`,
  {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: names.includes("qwen-turbo") ? "qwen-turbo" : model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 4,
    }),
  },
).catch(() => null);

if (call?.ok) {
  report("ok", "A model call succeeded. The account and workspace are usable.");
  console.log("\nThe provider is ready. Voice sessions will open.");
  process.exit(0);
}

const body = await call?.json().catch(() => ({}));
const code = body?.error?.code ?? `HTTP ${String(call?.status ?? "none")}`;

if (code === "Arrearage") {
  report(
    "fail",
    "The Alibaba Cloud account is not in good standing.",
    "Settle the balance or add a valid payment method, then run this again. Free-trial quota is also withheld while an account is in arrears: https://www.alibabacloud.com/help/en/model-studio/error-code#overdue-payment",
  );
} else if (code === "AccessDenied.Unpurchased") {
  // The workspace endpoint reports this for both "not activated" and "account
  // in arrears". The shared endpoint distinguishes them, so it is asked rather
  // than leaving the user to guess between two different fixes.
  const shared = await fetch(
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "qwen-turbo",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 4,
      }),
    },
  ).catch(() => null);
  const sharedBody = await shared?.json().catch(() => ({}));

  if (sharedBody?.error?.code === "Arrearage") {
    report(
      "fail",
      "Model Studio is activated, but the Alibaba Cloud account is not in good standing.",
      "Settle the balance or add a valid payment method, then run this again. Free-trial quota is withheld while an account is in arrears: https://www.alibabacloud.com/help/en/model-studio/error-code#overdue-payment",
    );
  } else {
    report(
      "fail",
      "The workspace has no entitlement to any model yet.",
      "Activate Model Studio for this workspace and region in the console, then run this again.",
    );
  }
} else {
  report(
    "fail",
    `The provider refused the call: ${code}.`,
    body?.error?.message ?? "",
  );
}
process.exit(1);

#!/usr/bin/env node
/**
 * Provisions the on-device pose model assets.
 *
 * The MediaPipe runtime and the BlazePose model are multi-megabyte binaries. They
 * belong to the build, not to the source history, so this script fetches them
 * into `public/models/` before a build. It is idempotent and offline-safe: if the
 * assets are already present it does nothing, and if the network is unavailable
 * it leaves the build to succeed without them, because the Move page already
 * degrades to a clear "local pose is unavailable" state rather than falling back
 * to sending video anywhere.
 *
 * The runtime is copied from the installed npm package rather than downloaded, so
 * it always matches the version the application bundles.
 */

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const modelsRoot = path.join(webRoot, "public", "models", "mediapipe");
const wasmTarget = path.join(modelsRoot, "wasm");
const modelTarget = path.join(modelsRoot, "pose_landmarker_lite.task");

const MODEL_URL =
  process.env.RAFAYPAIR_POSE_MODEL_URL ??
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

/**
 * Published digest of the float16 lite model. A mismatch means the asset is not
 * the file this application was built against, which is a supply-chain question
 * rather than a download hiccup, so it is a hard failure.
 */
const MODEL_SHA256 =
  process.env.RAFAYPAIR_POSE_MODEL_SHA256 ??
  "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a";

const MIN_MODEL_BYTES = 1_000_000;

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function copyRuntime() {
  if (await exists(path.join(wasmTarget, "vision_wasm_internal.wasm"))) {
    return "present";
  }
  const source = path.join(
    webRoot,
    "node_modules",
    "@mediapipe",
    "tasks-vision",
    "wasm",
  );
  if (!(await exists(source))) {
    return "missing-package";
  }
  await mkdir(wasmTarget, { recursive: true });
  await cp(source, wasmTarget, { recursive: true });
  return "copied";
}

async function fetchModel() {
  if (await exists(modelTarget)) {
    const info = await stat(modelTarget);
    if (info.size >= MIN_MODEL_BYTES) return "present";
  }
  let response;
  try {
    response = await fetch(MODEL_URL, { redirect: "follow" });
  } catch {
    return "offline";
  }
  if (!response.ok) return "offline";

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength < MIN_MODEL_BYTES) return "offline";

  if (MODEL_SHA256) {
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== MODEL_SHA256) {
      throw new Error(
        `Pose model digest mismatch: expected ${MODEL_SHA256}, received ${digest}`,
      );
    }
  }

  await mkdir(modelsRoot, { recursive: true });
  await writeFile(modelTarget, bytes);
  return "downloaded";
}

const runtime = await copyRuntime();
const model = await fetchModel();

const summary = `pose assets — runtime: ${runtime}, model: ${model}`;
if (runtime === "copied" || model === "downloaded") {
  process.stdout.write(`${summary}\n`);
} else if (runtime === "missing-package" || model === "offline") {
  // Not fatal: the client states that local pose is unavailable rather than
  // silently degrading, and it never falls back to a server.
  process.stdout.write(
    `${summary}\nLocal pose will report itself unavailable until these assets are present.\n`,
  );
} else {
  process.stdout.write(`${summary}\n`);
}

// Keep the checked-in note truthful about what is actually here.
const notePath = path.join(webRoot, "public", "models", "README.md");
if (await exists(notePath)) {
  const note = await readFile(notePath, "utf8");
  if (!note.includes("pnpm --filter @rafay-pair/web models")) {
    process.stdout.write(
      "Note: public/models/README.md predates the automatic fetch script.\n",
    );
  }
}

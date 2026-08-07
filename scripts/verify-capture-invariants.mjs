#!/usr/bin/env node
/**
 * The camera and the microphone may only be started by the person holding the
 * phone.
 *
 * Master specification §30: "Camera/mic cannot be remotely activated." That is
 * a claim about reachability, not about intent, so it is checked as one. Every
 * module that consumes something the network can deliver — a realtime event, a
 * push notification, a background sync — is read here and must not reference a
 * capture API or a capture controller at all. A module that cannot name the
 * camera cannot turn it on, however the message that reached it was shaped.
 *
 * This runs in `pnpm verify` and in CI rather than living in one client's test
 * suite, because the guarantee spans three codebases that share no code.
 */
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Anything that opens a sensor, on any of the three platforms. Names rather
 * than call graphs: a source file that never mentions these cannot reach them
 * without going through something that does, and that something is checked too.
 */
const CAPTURE_TOKENS = [
  "AVCaptureSession",
  "AVCaptureDevice",
  "installTap",
  "AVAudioEngine",
  "requestRecordPermission",
  "AudioRecord",
  "MediaRecorder.AudioSource",
  "ProcessCameraProvider",
  "bindToLifecycle",
  "getUserMedia",
  "CaptureSession",
  "CaptureController",
  "VoiceClient",
  "VoiceAudioIO",
];

/**
 * Modules that act on something arriving from the network. If any of these
 * could start a capture, "cannot be remotely activated" would be a convention
 * rather than a property.
 */
const NETWORK_DRIVEN = [
  "apps/ios/RafayPair/Core/Realtime/*.swift",
  "apps/ios/RafayPair/Core/Notifications/*.swift",
  "apps/android/app/src/main/java/com/rafaypair/android/data/network/RealtimeClient.kt",
  "apps/android/app/src/main/java/com/rafaypair/android/notifications/*.kt",
  "apps/android/app/src/main/java/com/rafaypair/android/data/repository/SyncWorkers.kt",
  "apps/web/src/api/client.ts",
  "apps/web/src/realtime/*.ts",
  "apps/web/src/service-worker.ts",
];

/**
 * The server may not name a capture API either. A push payload or realtime
 * envelope that carried one would be an instruction to a client, and the
 * clients above are the only things that read them.
 */
const SERVER_SOURCES = [
  "apps/api/src/**/*.ts",
  "apps/worker/src/**/*.ts",
  "services/notifications/src/*.ts",
  "services/realtime/src/*.ts",
];

const failures = [];

function check(patterns, label) {
  let examined = 0;
  for (const pattern of patterns) {
    for (const file of globSync(pattern, { cwd: root })) {
      if (file.includes("/build/") || file.endsWith(".test.ts")) continue;
      examined += 1;
      const source = readFileSync(join(root, file), "utf8");
      for (const token of CAPTURE_TOKENS) {
        if (source.includes(token)) {
          failures.push(
            `${relative(root, file)} (${label}) references ${token}`,
          );
        }
      }
    }
  }
  return examined;
}

const networkFiles = check(NETWORK_DRIVEN, "network-driven");
const serverFiles = check(SERVER_SOURCES, "server");

// A check that examines nothing passes trivially, which would be worse than
// failing: the paths above must keep matching real files as the tree moves.
if (networkFiles < 5) {
  failures.push(
    `Only ${String(networkFiles)} network-driven modules were examined; the paths in this script are stale.`,
  );
}
if (serverFiles < 10) {
  failures.push(
    `Only ${String(serverFiles)} server modules were examined; the paths in this script are stale.`,
  );
}

if (failures.length > 0) {
  console.error("Capture invariant violated:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `Capture invariant holds: ${String(networkFiles)} network-driven and ` +
    `${String(serverFiles)} server modules name no capture API.`,
);

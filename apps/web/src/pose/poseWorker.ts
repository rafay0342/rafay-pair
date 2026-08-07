/// <reference lib="webworker" />

/**
 * Pose inference worker.
 *
 * Runs the landmark model off the main thread so the camera preview stays
 * smooth. Video frames arrive as transferred `ImageBitmap`s and are closed
 * immediately after inference; only landmark arrays are posted back. Nothing in
 * this worker performs network I/O beyond loading the locally hosted model
 * assets, and nothing is uploaded.
 */

import type { BlazePoseLandmark } from "./landmarks";

export interface PoseWorkerInit {
  readonly type: "init";
  /** Directory holding the self-hosted WASM runtime files. */
  readonly wasmPath: string;
  /** URL of the self-hosted pose landmarker model. */
  readonly modelPath: string;
}

export interface PoseWorkerDetect {
  readonly type: "detect";
  readonly bitmap: ImageBitmap;
  readonly timestampMs: number;
}

export type PoseWorkerRequest = PoseWorkerInit | PoseWorkerDetect;

export type PoseWorkerResponse =
  | { readonly type: "ready" }
  | { readonly type: "unavailable"; readonly reason: string }
  | {
      readonly type: "landmarks";
      readonly timestampMs: number;
      readonly landmarks: readonly BlazePoseLandmark[] | undefined;
    };

interface PoseLandmarkerLike {
  detectForVideo(
    bitmap: ImageBitmap,
    timestampMs: number,
  ): { landmarks?: BlazePoseLandmark[][] };
}

let landmarker: PoseLandmarkerLike | undefined;

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener("message", (event: MessageEvent<PoseWorkerRequest>) => {
  const request = event.data;
  if (request.type === "init") {
    void initialise(request);
    return;
  }
  detect(request);
});

async function initialise(request: PoseWorkerInit): Promise<void> {
  try {
    const vision = await import("@mediapipe/tasks-vision");
    const fileset = await vision.FilesetResolver.forVisionTasks(
      request.wasmPath,
    );
    landmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: request.modelPath, delegate: "GPU" },
      runningMode: "VIDEO",
      numPoses: 1,
    });
    post({ type: "ready" });
  } catch (error) {
    // The model is a large binary provisioned at deploy time rather than
    // committed to the repository. A missing or unsupported runtime must
    // degrade to a clear message, never to a silent no-op.
    post({
      type: "unavailable",
      reason:
        error instanceof Error
          ? error.message
          : "The pose model could not be loaded.",
    });
  }
}

function detect(request: PoseWorkerDetect): void {
  if (!landmarker) {
    request.bitmap.close();
    return;
  }
  try {
    const result = landmarker.detectForVideo(
      request.bitmap,
      request.timestampMs,
    );
    post({
      type: "landmarks",
      timestampMs: request.timestampMs,
      landmarks: result.landmarks?.[0],
    });
  } catch {
    post({
      type: "landmarks",
      timestampMs: request.timestampMs,
      landmarks: undefined,
    });
  } finally {
    // Releasing the bitmap here is what keeps frame data from accumulating.
    request.bitmap.close();
  }
}

function post(message: PoseWorkerResponse): void {
  self.postMessage(message);
}

import type { PoseFrame } from "@rafay-pair/pose-engine";

import { toCanonicalFrame } from "./landmarks";
import type { PoseWorkerResponse } from "./poseWorker";

/**
 * Browser camera pose capture.
 *
 * Frames never leave the device: `getUserMedia` output is drawn to an offscreen
 * bitmap, transferred to the inference worker, and closed there. Only landmark
 * arrays cross back, and nothing is uploaded or persisted. This class is the
 * single boundary at which the "no camera upload" guarantee can be audited.
 */

export type CaptureState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "running" }
  | { readonly kind: "denied" }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface CameraPoseControllerOptions {
  readonly onFrame: (frame: PoseFrame) => void;
  readonly onState: (state: CaptureState) => void;
  /** Directory of the self-hosted MediaPipe WASM runtime. */
  readonly wasmPath?: string;
  /** URL of the self-hosted pose landmarker model. */
  readonly modelPath?: string;
}

const DEFAULT_WASM_PATH = "/models/mediapipe/wasm";
const DEFAULT_MODEL_PATH = "/models/mediapipe/pose_landmarker_lite.task";

export class CameraPoseController {
  private worker: Worker | undefined;
  private stream: MediaStream | undefined;
  private video: HTMLVideoElement | undefined;
  private frameHandle: number | undefined;
  private running = false;
  private busy = false;

  public constructor(private readonly options: CameraPoseControllerOptions) {}

  public async start(video: HTMLVideoElement): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.video = video;
    this.options.onState({ kind: "starting" });

    if (!navigator.mediaDevices?.getUserMedia) {
      this.fail("This browser cannot open a camera.");
      return;
    }
    if (typeof createImageBitmap !== "function") {
      this.fail("This browser cannot process camera frames locally.");
      return;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: 640, height: 480 },
        audio: false,
      });
    } catch (error) {
      this.running = false;
      this.options.onState(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? { kind: "denied" }
          : { kind: "unavailable", reason: "The camera could not be opened." },
      );
      return;
    }

    video.srcObject = this.stream;
    video.muted = true;
    video.playsInline = true;
    await video.play().catch(() => undefined);

    this.worker = new Worker(new URL("./poseWorker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.addEventListener("message", this.handleWorkerMessage);
    this.worker.postMessage({
      type: "init",
      wasmPath: this.options.wasmPath ?? DEFAULT_WASM_PATH,
      modelPath: this.options.modelPath ?? DEFAULT_MODEL_PATH,
    });
  }

  public stop(): void {
    this.running = false;
    if (this.frameHandle !== undefined) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = undefined;
    }
    this.worker?.removeEventListener("message", this.handleWorkerMessage);
    this.worker?.terminate();
    this.worker = undefined;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = undefined;
    if (this.video) this.video.srcObject = null;
    this.video = undefined;
    this.busy = false;
    this.options.onState({ kind: "idle" });
  }

  private readonly handleWorkerMessage = (
    event: MessageEvent<PoseWorkerResponse>,
  ): void => {
    const message = event.data;
    if (message.type === "ready") {
      this.options.onState({ kind: "running" });
      this.scheduleFrame();
      return;
    }
    if (message.type === "unavailable") {
      this.fail(message.reason);
      return;
    }
    this.busy = false;
    const frame = toCanonicalFrame(message.landmarks, message.timestampMs);
    if (frame) this.options.onFrame(frame);
    this.scheduleFrame();
  };

  private scheduleFrame(): void {
    if (!this.running) return;
    this.frameHandle = requestAnimationFrame(() => {
      void this.captureFrame();
    });
  }

  private async captureFrame(): Promise<void> {
    const video = this.video;
    const worker = this.worker;
    if (!this.running || !video || !worker) return;
    // One frame in flight at a time. Queuing them would grow latency without
    // improving the result, because only the newest frame is worth scoring.
    if (this.busy || video.readyState < 2) {
      this.scheduleFrame();
      return;
    }

    this.busy = true;
    try {
      const bitmap = await createImageBitmap(video);
      worker.postMessage(
        {
          type: "detect",
          bitmap,
          timestampMs: performance.now(),
        },
        [bitmap],
      );
    } catch {
      this.busy = false;
      this.scheduleFrame();
    }
  }

  private fail(reason: string): void {
    this.stop();
    this.options.onState({ kind: "unavailable", reason });
  }
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ExerciseEngine,
  PoseEngine,
  type FormEvent,
  type PoseFrame,
  type ReportedPosture,
  type Repetition,
  type SessionSummary,
} from "@rafay-pair/pose-engine";

import { InlineAlert } from "../components/Feedback";
import {
  CameraPoseController,
  type CaptureState,
} from "../pose/CameraPoseController";

interface LiveState {
  readonly posture: ReportedPosture;
  readonly repetitionCount: number;
  readonly tracking: boolean;
  readonly framingOk: boolean;
  readonly lastRepetition: Repetition | undefined;
}

const IDLE_STATE: LiveState = {
  posture: "unknown",
  repetitionCount: 0,
  tracking: false,
  framingOk: true,
  lastRepetition: undefined,
};

export function MovePage(): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const poseEngine = useRef(new PoseEngine());
  const exerciseEngine = useRef(new ExerciseEngine());
  const controllerRef = useRef<CameraPoseController>(undefined);

  const [capture, setCapture] = useState<CaptureState>({ kind: "idle" });
  const [live, setLive] = useState<LiveState>(IDLE_STATE);
  const [recording, setRecording] = useState(false);
  const [summary, setSummary] = useState<SessionSummary | undefined>(undefined);

  const handleFrame = useCallback((frame: PoseFrame): void => {
    const observation = poseEngine.current.process(frame);
    const result = exerciseEngine.current.process(observation);
    setLive((current) => ({
      posture: result.reportedPosture,
      repetitionCount: result.repetitionCount,
      tracking: observation.valid,
      framingOk: observation.framingOk,
      lastRepetition: result.completedRepetition ?? current.lastRepetition,
    }));
  }, []);

  useEffect(
    () => () => {
      controllerRef.current?.stop();
      controllerRef.current = undefined;
    },
    [],
  );

  const start = useCallback(async (): Promise<void> => {
    const video = videoRef.current;
    if (!video) return;
    poseEngine.current.reset();
    exerciseEngine.current.reset();
    setLive(IDLE_STATE);
    setSummary(undefined);
    setRecording(true);

    const controller = new CameraPoseController({
      onFrame: handleFrame,
      onState: setCapture,
    });
    controllerRef.current = controller;
    await controller.start(video);
  }, [handleFrame]);

  const stop = useCallback((): void => {
    controllerRef.current?.stop();
    controllerRef.current = undefined;
    setRecording(false);
    setSummary(exerciseEngine.current.summary());
  }, []);

  const guidance = useMemo(() => {
    if (!recording) return "Start a session when you are ready.";
    if (capture.kind === "starting") return "Preparing the on-device model…";
    if (!live.tracking) return "Step into view so your whole body is visible.";
    if (!live.framingOk) {
      return "Move back a little — your feet are outside the frame.";
    }
    switch (live.posture) {
      case "unknown":
        return "Hold still for a moment while tracking settles.";
      case "standing":
        return "Standing. Lower into a squat when you are ready.";
      case "squatting":
        return "Squatting — keep your chest lifted.";
      case "sitting":
        return "Sitting.";
      case "lyingDown":
        return "Lying down.";
      default:
        return "Tracking.";
    }
  }, [capture.kind, live, recording]);

  return (
    <div className="page-stack narrow-page">
      <header className="page-heading">
        <p className="eyebrow">Move</p>
        <h1>Squat session</h1>
        <p>
          Your camera stays in this browser. Frames are analysed on this device
          and never recorded or uploaded.
        </p>
      </header>

      {capture.kind === "denied" && (
        <InlineAlert tone="warning" title="Camera access is off">
          Allow camera access for this site to run a local workout.
        </InlineAlert>
      )}
      {capture.kind === "unavailable" && (
        <InlineAlert tone="warning" title="Local pose is unavailable here">
          {capture.reason} Pose runs entirely on your device, so RafayPair will
          not fall back to sending video to a server.
        </InlineAlert>
      )}

      <section
        className="privacy-control"
        aria-labelledby="move-camera-heading"
      >
        <h2 id="move-camera-heading" className="sr-only">
          Camera preview
        </h2>
        <video
          ref={videoRef}
          className="pose-preview"
          playsInline
          muted
          aria-label="Local camera preview"
        />
        <button
          className={`button ${recording ? "" : "button--danger"}`}
          type="button"
          onClick={() => {
            if (recording) stop();
            else void start();
          }}
        >
          {recording ? "End session" : "Start session"}
        </button>
      </section>

      <section className="pause-effects" aria-labelledby="move-status-heading">
        <h2 id="move-status-heading">
          {live.repetitionCount}{" "}
          {live.repetitionCount === 1 ? "squat" : "squats"}
        </h2>
        <p>{guidance}</p>
        {live.lastRepetition?.formEvents.map((event) => (
          <p key={event} className="form-hint">
            {formHint(event)}
          </p>
        ))}
      </section>

      {summary && (
        <section
          className="pause-effects"
          aria-labelledby="move-summary-heading"
        >
          <h2 id="move-summary-heading">Session summary</h2>
          <p>{summary.repetitionCount} squats recorded on this device.</p>
          {summary.repetitionCount > 0 && (
            <p>
              Best depth {Math.round(summary.bestDepth * 100)}% of a full squat.
            </p>
          )}
          <p>Sharing this with your partner is a separate choice in Consent.</p>
        </section>
      )}
    </div>
  );
}

function formHint(event: FormEvent): string {
  switch (event) {
    case "shallowDepth":
      return "Try to sit a little lower on the next one.";
    case "forwardLean":
      return "Keep your chest a bit more upright.";
    case "uneven":
      return "Weight looked uneven between your legs.";
    default:
      return "";
  }
}

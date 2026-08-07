# On-device pose model assets

The Web client runs pose inference locally. It needs two self-hosted assets,
which are deliberately **not** committed — they are multi-megabyte binaries and
belong to the build, not the source history:

```text
public/models/mediapipe/wasm/                 MediaPipe Tasks Vision WASM runtime
public/models/mediapipe/pose_landmarker_lite.task   BlazePose Lite model
```

Provision them during the build or deploy step:

```bash
mkdir -p apps/web/public/models/mediapipe/wasm
cp -R node_modules/@mediapipe/tasks-vision/wasm/. apps/web/public/models/mediapipe/wasm/
curl -fsSL -o apps/web/public/models/mediapipe/pose_landmarker_lite.task \
  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task
```

Self-hosting is required, not optional: loading the runtime from a third-party
CDN would leak a request on every workout and would break the offline promise of
the installed PWA.

When the assets are absent the Move page reports that local pose is unavailable
and stops. It never falls back to sending video to a server — there is no such
path in the client.

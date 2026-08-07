# Pose engine specification

Normative for every RafayPair client. iOS, Android, and Web each implement this
independently in their own language; none of them shares code with another. The
golden vectors in `tests/golden/pose` are the parity contract between them.

## 1. Scope

This specification covers everything downstream of landmark inference:
canonical skeleton, normalization, smoothing, geometry, and static posture
classification. Landmark inference itself is platform-specific (Vision on iOS,
ML Kit on Android, a browser model runtime on Web) and is therefore outside the
parity contract.

Raw camera frames never leave the device. The engine consumes landmarks only.

## 2. Canonical skeleton

Every platform reduces its native landmark set to these thirteen joints, which
are the intersection of Apple Vision, ML Kit Pose Detection, and BlazePose:

```text
nose
leftShoulder   rightShoulder
leftElbow      rightElbow
leftWrist      rightWrist
leftHip        rightHip
leftKnee       rightKnee
leftAnkle      rightAnkle
```

A joint is `{ x, y, visibility }`:

- `x`, `y` are image-normalized coordinates. Origin is the top-left of the
  upright, display-oriented frame. `x` grows right, `y` grows **down**. Values
  outside `[0, 1]` are permitted (a joint may be predicted off-frame) and are
  not clamped.
- `visibility` is `0…1`. Platforms that report a confidence use it directly;
  platforms that report only presence use `1` for present and `0` for absent.

A frame is `{ timestampMs, joints }`. `timestampMs` is a monotonic
millisecond clock. Frames must be delivered in nondecreasing timestamp order; a
frame whose timestamp is not greater than its predecessor is dropped.

Platforms need **not** agree on what "left" means, and need not correct for a
mirrored front-facing camera. Every quantity the engine derives is built from
midpoints of left/right pairs, means of left/right angles, or unsigned angles,
and the one asymmetric-looking output — the `uneven` form event — uses the
absolute difference between the two knee angles. All of these are invariant
under swapping the left and right labels and under reflecting the frame
horizontally.

This is a deliberate design constraint rather than an accident: Apple Vision,
ML Kit, and BlazePose do not document laterality identically, so a normalization
step would be a per-platform guess that silently changes results. Keeping the
engine invariant removes the question entirely. Any future feature that genuinely
needs to distinguish left from right must establish laterality explicitly and
carry its own golden coverage.

## 3. Validity

`MIN_VISIBILITY = 0.5`

A joint is _usable_ when `visibility >= MIN_VISIBILITY`.

The **core set** is both shoulders, both hips, both knees, and both ankles. A
frame is _valid_ only when every core joint is usable and the torso scale
(§4) is at least `MIN_TORSO_SCALE = 0.02`. An invalid frame produces the
posture `unknown` and does not update the smoothing state.

## 4. Normalization

All derived geometry is computed in a translation- and scale-invariant frame:

```text
hipCenter       = midpoint(leftHip, rightHip)
shoulderCenter  = midpoint(leftShoulder, rightShoulder)
ankleCenter     = midpoint(leftAnkle, rightAnkle)
torsoScale      = euclideanDistance(hipCenter, shoulderCenter)
```

For any joint `j`:

```text
normalized(j).x = (j.x - hipCenter.x) / torsoScale
normalized(j).y = (j.y - hipCenter.y) / torsoScale
```

Normalized `y` still grows downward. Where the specification refers to a joint
being _above_ another it means a smaller `y`.

## 5. Smoothing

An exponential moving average is applied to the **raw image-space** coordinates
of each joint, before normalization, with a fixed coefficient:

```text
SMOOTHING_ALPHA = 0.4

smoothed[0]  = raw[0]
smoothed[n]  = SMOOTHING_ALPHA * raw[n] + (1 - SMOOTHING_ALPHA) * smoothed[n-1]
```

A fixed coefficient is mandated instead of a velocity-adaptive filter because
identical arithmetic is required for cross-platform parity. Smoothing state is
per-joint and per-coordinate; `visibility` is never smoothed. The state resets
when the engine is reset, and an invalid frame leaves the state untouched.

## 6. Derived geometry

`angleAtVertex(a, vertex, b)` is the unsigned angle in degrees between the
vectors `a - vertex` and `b - vertex`, in `[0, 180]`, computed with `atan2` on
the cross and dot products. When either vector has magnitude below `1e-9` the
angle is reported as `180`.

```text
kneeAngle(side)  = angleAtVertex(hip[side], knee[side], ankle[side])
hipAngle(side)   = angleAtVertex(shoulder[side], hip[side], knee[side])
meanKneeAngle    = (kneeAngle(left) + kneeAngle(right)) / 2
meanHipAngle     = (hipAngle(left) + hipAngle(right)) / 2
```

`torsoAngleDeg` is the tilt of the torso away from image-vertical, in
`[0, 180]`:

```text
torsoAngleDeg = angleBetween(shoulderCenter - hipCenter, imageUp)
imageUp       = (0, -1)
```

`0` is perfectly upright, `90` is horizontal, `180` is inverted.

`hipElevation` is the vertical distance from the ankles up to the hips,
expressed in torso lengths:

```text
hipElevation = (ankleCenter.y - hipCenter.y) / torsoScale
```

It is positive when the hips are above the ankles. It is the primary depth
signal: an adult standing upright measures roughly `1.5`, seated on a chair
roughly `0.9`, and at the bottom of a deep squat roughly `0.6`. It is
scale-invariant and, unlike raw joint height, unaffected by the subject's
distance from the camera.

## 7. Static posture classification

The classifier is a pure function of a single valid frame. It is deliberately
conservative: sitting and the bottom of a squat are not distinguishable from one
frame, so both are reported as `crouched` and the exercise state machine
(`engines/exercise-state-machines/SPEC.md`) separates them over time.

```text
LYING_TORSO_ANGLE_DEG   = 60
STANDING_HIP_ELEVATION  = 1.30
STANDING_KNEE_ANGLE     = 150
CROUCHED_HIP_ELEVATION  = 1.15
CROUCHED_KNEE_ANGLE     = 135
```

Evaluated in order; the first match wins:

1. frame is not valid → `unknown`
2. `torsoAngleDeg >= LYING_TORSO_ANGLE_DEG` → `lying`
3. `hipElevation >= STANDING_HIP_ELEVATION` and
   `meanKneeAngle >= STANDING_KNEE_ANGLE` → `standing`
4. `hipElevation <= CROUCHED_HIP_ELEVATION` and
   `meanKneeAngle <= CROUCHED_KNEE_ANGLE` → `crouched`
5. otherwise → `transitional`

The gap between `CROUCHED_HIP_ELEVATION` (1.15) and `STANDING_HIP_ELEVATION`
(1.30) is a deliberate dead band. Postures inside it report `transitional`
rather than flickering between the two committed states.

## 8. Engine output

For each frame the engine emits:

```text
timestampMs
valid            boolean
posture          unknown | lying | standing | crouched | transitional
torsoAngleDeg    number
meanKneeAngle    number
meanHipAngle     number
hipElevation     number
minVisibility    number   lowest visibility across the core set
framingOk        boolean  every core joint lies within [0,1] on both axes
```

`framingOk` drives the "step back so your whole body is visible" guidance and
never gates classification.

## 9. Numeric parity

Every implementation uses IEEE-754 double precision and the operation order
written above. Addition, subtraction, multiplication, division, and square root
are exactly reproducible across platforms; `atan2` is not guaranteed to be
bit-identical between C libraries. Golden vectors therefore assert:

- discrete fields (`valid`, `posture`, `framingOk`) exactly, and
- continuous fields within `1e-6` absolute tolerance.

Vectors are authored so that no frame sits within `0.01` of a classification
threshold, which keeps discrete agreement independent of last-bit differences.

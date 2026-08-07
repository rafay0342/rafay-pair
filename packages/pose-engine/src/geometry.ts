/**
 * Geometry primitives shared by the pose engine.
 *
 * Operation order matters: the Swift and Kotlin ports reproduce these
 * expressions literally so that golden vectors agree to within the tolerance
 * documented in `engines/pose-spec/SPEC.md` §9.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

const DEGREES_PER_RADIAN = 180 / Math.PI;
const MIN_VECTOR_MAGNITUDE = 1e-9;

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function distance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Unsigned angle in degrees between vectors, in `[0, 180]`.
 *
 * `atan2(|cross|, dot)` is used rather than `acos(dot / (|a| * |b|))` because
 * it stays accurate for nearly parallel and nearly antiparallel vectors, where
 * the cosine form loses precision exactly at the extended-limb angles the
 * classifier cares about.
 */
export function angleBetween(a: Point, b: Point): number {
  const magnitudeA = Math.sqrt(a.x * a.x + a.y * a.y);
  const magnitudeB = Math.sqrt(b.x * b.x + b.y * b.y);
  if (magnitudeA < MIN_VECTOR_MAGNITUDE || magnitudeB < MIN_VECTOR_MAGNITUDE) {
    return 180;
  }
  const cross = Math.abs(a.x * b.y - a.y * b.x);
  const dot = a.x * b.x + a.y * b.y;
  return Math.atan2(cross, dot) * DEGREES_PER_RADIAN;
}

/** Angle at `vertex` subtended by `a` and `b`, in `[0, 180]`. */
export function angleAtVertex(a: Point, vertex: Point, b: Point): number {
  return angleBetween(
    { x: a.x - vertex.x, y: a.y - vertex.y },
    { x: b.x - vertex.x, y: b.y - vertex.y },
  );
}

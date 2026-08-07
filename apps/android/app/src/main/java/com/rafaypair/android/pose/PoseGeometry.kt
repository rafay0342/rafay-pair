package com.rafaypair.android.pose

import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.sqrt

/**
 * Geometry primitives for the pose engine.
 *
 * The expression order matches `packages/pose-engine/src/geometry.ts` literally.
 * Addition, subtraction, multiplication, division, and square root are exactly
 * reproducible across platforms; `atan2` is not guaranteed to be, which is why
 * golden vectors compare continuous values with a tolerance.
 */
object PoseGeometry {
    data class Point(val x: Double, val y: Double)

    private const val DEGREES_PER_RADIAN = 180.0 / Math.PI
    private const val MIN_VECTOR_MAGNITUDE = 1e-9

    fun midpoint(a: Point, b: Point): Point = Point((a.x + b.x) / 2, (a.y + b.y) / 2)

    fun distance(a: Point, b: Point): Double {
        val dx = a.x - b.x
        val dy = a.y - b.y
        return sqrt(dx * dx + dy * dy)
    }

    /**
     * Unsigned angle in degrees between vectors, in `0..180`.
     *
     * `atan2(|cross|, dot)` is used rather than the cosine form because it stays
     * accurate for nearly parallel and nearly antiparallel vectors — exactly the
     * extended-limb angles the classifier depends on.
     */
    fun angleBetween(a: Point, b: Point): Double {
        val magnitudeA = sqrt(a.x * a.x + a.y * a.y)
        val magnitudeB = sqrt(b.x * b.x + b.y * b.y)
        if (magnitudeA < MIN_VECTOR_MAGNITUDE || magnitudeB < MIN_VECTOR_MAGNITUDE) {
            return 180.0
        }
        val cross = abs(a.x * b.y - a.y * b.x)
        val dot = a.x * b.x + a.y * b.y
        return atan2(cross, dot) * DEGREES_PER_RADIAN
    }

    /** Angle at [vertex] subtended by [a] and [b], in `0..180`. */
    fun angleAtVertex(a: Point, vertex: Point, b: Point): Double = angleBetween(
        Point(a.x - vertex.x, a.y - vertex.y),
        Point(b.x - vertex.x, b.y - vertex.y),
    )
}

internal fun Joint.point(): PoseGeometry.Point = PoseGeometry.Point(x, y)

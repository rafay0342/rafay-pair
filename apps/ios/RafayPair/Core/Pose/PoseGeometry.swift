import Foundation

/// Geometry primitives for the pose engine.
///
/// The expression order matches `packages/pose-engine/src/geometry.ts`
/// literally. Addition, subtraction, multiplication, division, and square root
/// are exactly reproducible across platforms; `atan2` is not guaranteed to be,
/// which is why golden vectors compare continuous values with a tolerance.
enum PoseGeometry {
    struct Point: Sendable, Equatable {
        var x: Double
        var y: Double
    }

    private static let degreesPerRadian = 180.0 / Double.pi
    private static let minVectorMagnitude = 1e-9

    static func midpoint(_ a: Point, _ b: Point) -> Point {
        Point(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
    }

    static func distance(_ a: Point, _ b: Point) -> Double {
        let dx = a.x - b.x
        let dy = a.y - b.y
        return (dx * dx + dy * dy).squareRoot()
    }

    /// Unsigned angle in degrees between vectors, in `0...180`.
    ///
    /// `atan2(|cross|, dot)` is used rather than the cosine form because it
    /// stays accurate for nearly parallel and nearly antiparallel vectors —
    /// exactly the extended-limb angles the classifier depends on.
    static func angleBetween(_ a: Point, _ b: Point) -> Double {
        let magnitudeA = (a.x * a.x + a.y * a.y).squareRoot()
        let magnitudeB = (b.x * b.x + b.y * b.y).squareRoot()
        guard magnitudeA >= minVectorMagnitude, magnitudeB >= minVectorMagnitude else {
            return 180
        }
        let cross = abs(a.x * b.y - a.y * b.x)
        let dot = a.x * b.x + a.y * b.y
        return atan2(cross, dot) * degreesPerRadian
    }

    /// Angle at `vertex` subtended by `a` and `b`, in `0...180`.
    static func angleAtVertex(_ a: Point, _ vertex: Point, _ b: Point) -> Double {
        angleBetween(
            Point(x: a.x - vertex.x, y: a.y - vertex.y),
            Point(x: b.x - vertex.x, y: b.y - vertex.y)
        )
    }
}

extension Joint {
    var point: PoseGeometry.Point {
        PoseGeometry.Point(x: x, y: y)
    }
}

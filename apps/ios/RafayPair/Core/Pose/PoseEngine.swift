import Foundation

/// Per-frame pose engine — the Swift implementation of `engines/pose-spec/SPEC.md`.
///
/// Stateful only in its smoothing filter. Given the same frame sequence from a
/// fresh value, every platform must produce the same observations.
struct PoseEngine: Sendable {
    private var smoothed: [Joint]?

    init() {}

    /// Discards smoothing history. Call between independent sequences.
    mutating func reset() {
        smoothed = nil
    }

    mutating func process(_ frame: PoseFrame) -> PoseObservation {
        let minVisibility = Self.lowestCoreVisibility(frame)
        let framingOk = Self.coreJointsWithinFrame(frame)

        // An unusable frame must not poison the smoothing state: a subject who
        // walks out of shot and back must resume from where they left, not from
        // a filter that averaged in garbage coordinates.
        guard minVisibility >= PoseTuning.minVisibility else {
            return Self.invalid(
                timestampMs: frame.timestampMs,
                minVisibility: minVisibility,
                framingOk: framingOk
            )
        }

        let joints = smooth(frame.joints)

        let hipCenter = PoseGeometry.midpoint(
            joints[JointName.leftHip.rawValue].point,
            joints[JointName.rightHip.rawValue].point
        )
        let shoulderCenter = PoseGeometry.midpoint(
            joints[JointName.leftShoulder.rawValue].point,
            joints[JointName.rightShoulder.rawValue].point
        )
        let ankleCenter = PoseGeometry.midpoint(
            joints[JointName.leftAnkle.rawValue].point,
            joints[JointName.rightAnkle.rawValue].point
        )
        let torsoScale = PoseGeometry.distance(hipCenter, shoulderCenter)

        guard torsoScale >= PoseTuning.minTorsoScale else {
            return Self.invalid(
                timestampMs: frame.timestampMs,
                minVisibility: minVisibility,
                framingOk: framingOk
            )
        }

        let torsoAngleDeg = PoseGeometry.angleBetween(
            PoseGeometry.Point(
                x: shoulderCenter.x - hipCenter.x,
                y: shoulderCenter.y - hipCenter.y
            ),
            PoseGeometry.Point(x: 0, y: -1)
        )
        let leftKneeAngle = PoseGeometry.angleAtVertex(
            joints[JointName.leftHip.rawValue].point,
            joints[JointName.leftKnee.rawValue].point,
            joints[JointName.leftAnkle.rawValue].point
        )
        let rightKneeAngle = PoseGeometry.angleAtVertex(
            joints[JointName.rightHip.rawValue].point,
            joints[JointName.rightKnee.rawValue].point,
            joints[JointName.rightAnkle.rawValue].point
        )
        let leftHipAngle = PoseGeometry.angleAtVertex(
            joints[JointName.leftShoulder.rawValue].point,
            joints[JointName.leftHip.rawValue].point,
            joints[JointName.leftKnee.rawValue].point
        )
        let rightHipAngle = PoseGeometry.angleAtVertex(
            joints[JointName.rightShoulder.rawValue].point,
            joints[JointName.rightHip.rawValue].point,
            joints[JointName.rightKnee.rawValue].point
        )
        let meanKneeAngle = (leftKneeAngle + rightKneeAngle) / 2
        let meanHipAngle = (leftHipAngle + rightHipAngle) / 2
        let hipElevation = (ankleCenter.y - hipCenter.y) / torsoScale

        return PoseObservation(
            timestampMs: frame.timestampMs,
            valid: true,
            posture: Self.classify(
                torsoAngleDeg: torsoAngleDeg,
                hipElevation: hipElevation,
                meanKneeAngle: meanKneeAngle
            ),
            torsoAngleDeg: torsoAngleDeg,
            meanKneeAngle: meanKneeAngle,
            meanHipAngle: meanHipAngle,
            leftKneeAngle: leftKneeAngle,
            rightKneeAngle: rightKneeAngle,
            hipElevation: hipElevation,
            minVisibility: minVisibility,
            framingOk: framingOk
        )
    }

    private mutating func smooth(_ raw: [Joint]) -> [Joint] {
        guard let previous = smoothed else {
            smoothed = raw
            return raw
        }
        let alpha = PoseTuning.smoothingAlpha
        var next = raw
        for index in raw.indices {
            next[index] = Joint(
                x: alpha * raw[index].x + (1 - alpha) * previous[index].x,
                y: alpha * raw[index].y + (1 - alpha) * previous[index].y,
                visibility: raw[index].visibility
            )
        }
        smoothed = next
        return next
    }

    /// Static posture from one frame. Sitting and the bottom of a squat are the
    /// same skeleton, so both resolve to `crouched`; the exercise state machine
    /// separates them over time.
    private static func classify(
        torsoAngleDeg: Double,
        hipElevation: Double,
        meanKneeAngle: Double
    ) -> Posture {
        if torsoAngleDeg >= PoseTuning.lyingTorsoAngleDeg { return .lying }
        if hipElevation >= PoseTuning.standingHipElevation,
            meanKneeAngle >= PoseTuning.standingKneeAngle
        {
            return .standing
        }
        if hipElevation <= PoseTuning.crouchedHipElevation,
            meanKneeAngle <= PoseTuning.crouchedKneeAngle
        {
            return .crouched
        }
        return .transitional
    }

    private static func invalid(
        timestampMs: Double,
        minVisibility: Double,
        framingOk: Bool
    ) -> PoseObservation {
        PoseObservation(
            timestampMs: timestampMs,
            valid: false,
            posture: .unknown,
            torsoAngleDeg: 0,
            meanKneeAngle: 0,
            meanHipAngle: 0,
            leftKneeAngle: 0,
            rightKneeAngle: 0,
            hipElevation: 0,
            minVisibility: minVisibility,
            framingOk: framingOk
        )
    }

    private static func lowestCoreVisibility(_ frame: PoseFrame) -> Double {
        var lowest = 1.0
        for name in JointName.core {
            let visibility = frame.joint(name).visibility
            if visibility < lowest { lowest = visibility }
        }
        return lowest
    }

    private static func coreJointsWithinFrame(_ frame: PoseFrame) -> Bool {
        for name in JointName.core {
            let joint = frame.joint(name)
            if joint.x < 0 || joint.x > 1 || joint.y < 0 || joint.y > 1 {
                return false
            }
        }
        return true
    }
}

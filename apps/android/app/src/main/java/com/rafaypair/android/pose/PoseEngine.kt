package com.rafaypair.android.pose

/**
 * Per-frame pose engine — the Kotlin implementation of `engines/pose-spec/SPEC.md`.
 *
 * Stateful only in its smoothing filter. Given the same frame sequence from a
 * fresh instance, every platform must produce the same observations.
 */
class PoseEngine {
    private var smoothed: List<Joint>? = null

    /** Discards smoothing history. Call between independent sequences. */
    fun reset() {
        smoothed = null
    }

    fun process(frame: PoseFrame): PoseObservation {
        val minVisibility = lowestCoreVisibility(frame)
        val framingOk = coreJointsWithinFrame(frame)

        // An unusable frame must not poison the smoothing state: a subject who
        // walks out of shot and back must resume from where they left, not from
        // a filter that averaged in garbage coordinates.
        if (minVisibility < PoseTuning.MIN_VISIBILITY) {
            return invalid(frame.timestampMs, minVisibility, framingOk)
        }

        val joints = smooth(frame.joints)

        val hipCenter = PoseGeometry.midpoint(
            joints[JointName.LEFT_HIP.ordinal].point(),
            joints[JointName.RIGHT_HIP.ordinal].point(),
        )
        val shoulderCenter = PoseGeometry.midpoint(
            joints[JointName.LEFT_SHOULDER.ordinal].point(),
            joints[JointName.RIGHT_SHOULDER.ordinal].point(),
        )
        val ankleCenter = PoseGeometry.midpoint(
            joints[JointName.LEFT_ANKLE.ordinal].point(),
            joints[JointName.RIGHT_ANKLE.ordinal].point(),
        )
        val torsoScale = PoseGeometry.distance(hipCenter, shoulderCenter)

        if (torsoScale < PoseTuning.MIN_TORSO_SCALE) {
            return invalid(frame.timestampMs, minVisibility, framingOk)
        }

        val torsoAngleDeg = PoseGeometry.angleBetween(
            PoseGeometry.Point(shoulderCenter.x - hipCenter.x, shoulderCenter.y - hipCenter.y),
            PoseGeometry.Point(0.0, -1.0),
        )
        val leftKneeAngle = PoseGeometry.angleAtVertex(
            joints[JointName.LEFT_HIP.ordinal].point(),
            joints[JointName.LEFT_KNEE.ordinal].point(),
            joints[JointName.LEFT_ANKLE.ordinal].point(),
        )
        val rightKneeAngle = PoseGeometry.angleAtVertex(
            joints[JointName.RIGHT_HIP.ordinal].point(),
            joints[JointName.RIGHT_KNEE.ordinal].point(),
            joints[JointName.RIGHT_ANKLE.ordinal].point(),
        )
        val leftHipAngle = PoseGeometry.angleAtVertex(
            joints[JointName.LEFT_SHOULDER.ordinal].point(),
            joints[JointName.LEFT_HIP.ordinal].point(),
            joints[JointName.LEFT_KNEE.ordinal].point(),
        )
        val rightHipAngle = PoseGeometry.angleAtVertex(
            joints[JointName.RIGHT_SHOULDER.ordinal].point(),
            joints[JointName.RIGHT_HIP.ordinal].point(),
            joints[JointName.RIGHT_KNEE.ordinal].point(),
        )
        val meanKneeAngle = (leftKneeAngle + rightKneeAngle) / 2
        val meanHipAngle = (leftHipAngle + rightHipAngle) / 2
        val hipElevation = (ankleCenter.y - hipCenter.y) / torsoScale

        return PoseObservation(
            timestampMs = frame.timestampMs,
            valid = true,
            posture = classify(torsoAngleDeg, hipElevation, meanKneeAngle),
            torsoAngleDeg = torsoAngleDeg,
            meanKneeAngle = meanKneeAngle,
            meanHipAngle = meanHipAngle,
            leftKneeAngle = leftKneeAngle,
            rightKneeAngle = rightKneeAngle,
            hipElevation = hipElevation,
            minVisibility = minVisibility,
            framingOk = framingOk,
        )
    }

    private fun smooth(raw: List<Joint>): List<Joint> {
        val previous = smoothed
        if (previous == null) {
            smoothed = raw
            return raw
        }
        val alpha = PoseTuning.SMOOTHING_ALPHA
        val next = raw.mapIndexed { index, joint ->
            Joint(
                x = alpha * joint.x + (1 - alpha) * previous[index].x,
                y = alpha * joint.y + (1 - alpha) * previous[index].y,
                visibility = joint.visibility,
            )
        }
        smoothed = next
        return next
    }

    /**
     * Static posture from one frame. Sitting and the bottom of a squat are the
     * same skeleton, so both resolve to [Posture.CROUCHED]; the exercise state
     * machine separates them over time.
     */
    private fun classify(
        torsoAngleDeg: Double,
        hipElevation: Double,
        meanKneeAngle: Double,
    ): Posture {
        if (torsoAngleDeg >= PoseTuning.LYING_TORSO_ANGLE_DEG) return Posture.LYING
        if (hipElevation >= PoseTuning.STANDING_HIP_ELEVATION &&
            meanKneeAngle >= PoseTuning.STANDING_KNEE_ANGLE
        ) {
            return Posture.STANDING
        }
        if (hipElevation <= PoseTuning.CROUCHED_HIP_ELEVATION &&
            meanKneeAngle <= PoseTuning.CROUCHED_KNEE_ANGLE
        ) {
            return Posture.CROUCHED
        }
        return Posture.TRANSITIONAL
    }

    private fun invalid(
        timestampMs: Double,
        minVisibility: Double,
        framingOk: Boolean,
    ): PoseObservation = PoseObservation(
        timestampMs = timestampMs,
        valid = false,
        posture = Posture.UNKNOWN,
        torsoAngleDeg = 0.0,
        meanKneeAngle = 0.0,
        meanHipAngle = 0.0,
        leftKneeAngle = 0.0,
        rightKneeAngle = 0.0,
        hipElevation = 0.0,
        minVisibility = minVisibility,
        framingOk = framingOk,
    )

    private fun lowestCoreVisibility(frame: PoseFrame): Double {
        var lowest = 1.0
        for (name in JointName.CORE) {
            val visibility = frame.joint(name).visibility
            if (visibility < lowest) lowest = visibility
        }
        return lowest
    }

    private fun coreJointsWithinFrame(frame: PoseFrame): Boolean {
        for (name in JointName.CORE) {
            val joint = frame.joint(name)
            if (joint.x < 0 || joint.x > 1 || joint.y < 0 || joint.y > 1) return false
        }
        return true
    }
}

package com.rafaypair.android.physiology

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `engines/breathing-estimation-spec/SPEC.md` §4.
 *
 * The property that matters is invariance to distance from the camera: without
 * it, walking towards the lens would read as an inhale — a confident wrong
 * breathing rate, which is worse than none.
 */
class ChestSampleTest {
    private fun landmarks(scale: Double, chestRise: Double): BreathingSample =
        ChestSample.from(
            timestampMs = 0.0,
            leftShoulder = ChestSample.Point(-0.1 * scale, (1 - chestRise) * scale, 0.9),
            rightShoulder = ChestSample.Point(0.1 * scale, (1 - chestRise) * scale, 0.9),
            leftHip = ChestSample.Point(-0.1 * scale, 2 * scale, 0.9),
            rightHip = ChestSample.Point(0.1 * scale, 2 * scale, 0.9),
        )

    @Test
    fun `chest offset is invariant to distance from the camera`() {
        val near = landmarks(1.0, 0.0)
        val far = landmarks(0.4, 0.0)
        assertTrue(near.tracked)
        assertTrue(far.tracked)
        assertEquals(near.chestOffset, far.chestOffset, 1e-10)
    }

    @Test
    fun `chest offset moves when the chest moves`() {
        assertNotEquals(landmarks(1.0, 0.05).chestOffset, landmarks(1.0, 0.0).chestOffset, 1e-6)
    }

    @Test
    fun `a frame the pose engine would refuse cannot become a sample`() {
        val tiny = landmarks(0.02, 0.0)
        assertFalse(tiny.tracked)
        assertEquals(0.0, tiny.chestOffset, 0.0)

        val hidden = ChestSample.from(
            timestampMs = 0.0,
            leftShoulder = ChestSample.Point(-0.1, 1.0, 0.9),
            rightShoulder = ChestSample.Point(0.1, 1.0, 0.9),
            leftHip = ChestSample.Point(-0.1, 2.0, 0.2),
            rightHip = ChestSample.Point(0.1, 2.0, 0.9),
        )
        assertFalse(hidden.tracked)
    }
}

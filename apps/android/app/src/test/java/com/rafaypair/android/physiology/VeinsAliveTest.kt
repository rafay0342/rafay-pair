package com.rafaypair.android.physiology

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Master specification §8, and parity with `packages/physiology-engine`. */
class VeinsAliveTest {
    @Test
    fun `rests rather than inventing a rate when no fresh pulse exists`() {
        // The whole point of the module. A vascular network pulsing at a
        // plausible 72 would be a fabricated measurement wearing an
        // animation's clothes.
        val resting = VeinsAlive.drivers(VeinsInput())
        assertNull(resting.contractionPeriodMs)
        assertEquals(PulseProvenance.NONE, resting.pulseProvenance)
    }

    @Test
    fun `animates from an estimate and says that is what it is`() {
        val driven = VeinsAlive.drivers(VeinsInput(pulseBpm = 60.0))
        assertEquals(1000.0, driven.contractionPeriodMs!!, 1e-9)
        assertEquals(PulseProvenance.ESTIMATED, driven.pulseProvenance)
    }

    @Test
    fun `refuses an implausible rate instead of clamping it`() {
        listOf(0.0, 20.0, 41.0, 211.0, 400.0, Double.NaN, Double.POSITIVE_INFINITY).forEach { bpm ->
            val result = VeinsAlive.drivers(VeinsInput(pulseBpm = bpm))
            assertNull(bpm.toString(), result.contractionPeriodMs)
            assertEquals(bpm.toString(), PulseProvenance.NONE, result.pulseProvenance)
        }
    }

    @Test
    fun `glows with the breath and not otherwise`() {
        fun glow(phase: BreathingPhase?, progress: Double) =
            VeinsAlive.drivers(
                VeinsInput(breathingPhase = phase, breathingProgress = progress),
            ).chestGlow

        assertEquals(0.0, glow(BreathingPhase.INHALE, 0.0), 1e-9)
        assertEquals(1.0, glow(BreathingPhase.INHALE, 1.0), 1e-9)
        assertEquals(1.0, glow(BreathingPhase.HOLD, 0.5), 1e-9)
        assertEquals(0.0, glow(BreathingPhase.EXHALE, 1.0), 1e-9)
        // No session running: the chest does not breathe on screen while the
        // user is doing something else.
        assertEquals(0.0, glow(null, 0.5), 1e-9)
    }

    @Test
    fun `keeps intensity inside its range whatever the effort`() {
        assertEquals(0.15, VeinsAlive.drivers(VeinsInput()).intensity, 1e-9)
        val flatOut = VeinsAlive.drivers(
            VeinsInput(mode = VeinsMode.WORKOUT, repetitionsPerMinute = 500.0),
        )
        assertTrue(flatOut.intensity <= 1.0)
        assertTrue(flatOut.intensity > 0.9)
    }

    @Test
    fun `carries the disclosure`() {
        assertEquals(VeinsAlive.DISCLOSURE, VeinsAlive.drivers(VeinsInput()).disclosure)
        assertTrue(VeinsAlive.DISCLOSURE.contains("not a medical scan"))
    }

    @Test
    fun `keeps the exercise's own muscle order and drops repeats`() {
        val drivers = VeinsAlive.drivers(
            VeinsInput(
                activeMuscles = listOf(
                    MuscleGroup.QUADRICEPS,
                    MuscleGroup.GLUTES,
                    MuscleGroup.QUADRICEPS,
                ),
            ),
        )
        assertEquals(listOf(MuscleGroup.QUADRICEPS, MuscleGroup.GLUTES), drivers.activeMuscles)
    }
}

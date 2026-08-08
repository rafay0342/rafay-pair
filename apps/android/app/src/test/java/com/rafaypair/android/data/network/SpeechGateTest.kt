package com.rafaypair.android.data.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** `engines/speech-gate/SPEC.md`, and parity with the TypeScript engine. */
class SpeechGateTest {
    private fun run(gate: SpeechGate, level: Double, frames: Int): List<Boolean> =
        (1..frames).map { gate.accept(level).transmit }

    @Test
    fun `stays shut through a quiet room`() {
        assertFalse(run(SpeechGate(), 0.0006, 200).any { it })
    }

    @Test
    fun `opens for someone speaking into the phone`() {
        val gate = SpeechGate()
        run(gate, 0.0008, 100)
        assertTrue(run(gate, 0.12, 25).any { it })
    }

    @Test
    fun `stays shut for a television across the room`() {
        val gate = SpeechGate()
        run(gate, 0.001, 100)
        // Well above the floor by ratio, but nowhere near the phone. The
        // absolute near minimum is what refuses it.
        assertFalse(run(gate, 0.006, 200).any { it })
    }

    @Test
    fun `does not close during the pauses inside a sentence`() {
        val gate = SpeechGate()
        run(gate, 0.0008, 100)
        run(gate, 0.12, 10)
        // Without hangover the provider hears speech chopped into pieces, which
        // is heard at the other end as an assistant that interrupts.
        assertTrue(run(gate, 0.004, 8).all { it })
    }

    @Test
    fun `closes once the person has actually stopped`() {
        val gate = SpeechGate()
        run(gate, 0.0008, 100)
        run(gate, 0.12, 20)
        assertFalse(run(gate, 0.0009, 40).last())
    }

    @Test
    fun `measures a frame the way the specification says`() {
        assertEquals(0.0, SpeechGate.rms(ByteArray(0), 0), 1e-9)
        // Full-scale square wave is 1.0 by definition.
        val square = byteArrayOf(0xFF.toByte(), 0x7F, 0x00, 0x80.toByte())
        assertEquals(1.0, SpeechGate.rms(square, 4), 0.01)
    }
}

package com.rafaypair.android.data.network

import kotlin.math.max
import kotlin.math.sqrt

/**
 * The speech gate.
 *
 * `engines/speech-gate/SPEC.md` is normative. It decides, on the device and
 * before anything is transmitted, whether a frame is the person holding the
 * phone or the rest of the room.
 *
 * It is near-field gating, not speaker identification: it distinguishes close
 * from far, not this person from that person. Someone else speaking directly
 * into the same phone will pass it.
 */
object SpeechGateTuning {
    const val FLOOR_FALL = 0.2
    const val FLOOR_RISE = 0.002
    const val FLOOR_MINIMUM = 0.0008
    const val OPEN_RATIO = 6.0
    const val CLOSE_RATIO = 3.0
    const val NEAR_MINIMUM = 0.01
    const val HANGOVER_FRAMES = 12
}

data class GateDecision(
    /** What the caller acts on: send this frame, or drop it. */
    val transmit: Boolean,
    val open: Boolean,
    val rms: Double,
    val floor: Double,
)

/**
 * Stateful across a session, because the floor is a memory of the room.
 *
 * One instance per voice session. Reusing one would carry the previous room's
 * noise into a new one.
 */
class SpeechGate {
    private var floor = SpeechGateTuning.FLOOR_MINIMUM
    private var isOpen = false
    private var hangover = 0

    /** Every frame must be offered, including ones that are not transmitted. */
    fun accept(rms: Double): GateDecision {
        // The floor falls quickly and rises slowly. A floor that rose quickly
        // would climb during speech until the speaker no longer cleared it, and
        // the gate would close mid-sentence.
        val rate = if (rms < floor) SpeechGateTuning.FLOOR_FALL else SpeechGateTuning.FLOOR_RISE
        floor = max(SpeechGateTuning.FLOOR_MINIMUM, floor + (rms - floor) * rate)

        val openLevel = max(floor * SpeechGateTuning.OPEN_RATIO, SpeechGateTuning.NEAR_MINIMUM)
        val closeLevel = floor * SpeechGateTuning.CLOSE_RATIO

        if (!isOpen) {
            // Opening is harder than staying open, which is how a human listener
            // works too, and is what stops a voice at the boundary from chopping
            // a sentence into fragments.
            if (rms >= openLevel) {
                isOpen = true
                hangover = SpeechGateTuning.HANGOVER_FRAMES
            }
        } else if (rms >= closeLevel) {
            hangover = SpeechGateTuning.HANGOVER_FRAMES
        } else {
            hangover -= 1
            if (hangover <= 0) isOpen = false
        }

        return GateDecision(transmit = isOpen, open = isOpen, rms = rms, floor = floor)
    }

    fun reset() {
        floor = SpeechGateTuning.FLOOR_MINIMUM
        isOpen = false
        hangover = 0
    }

    companion object {
        /** Root-mean-square amplitude of one PCM16 frame, normalised to 0..1. */
        fun rms(frame: ByteArray, byteCount: Int): Double {
            val samples = byteCount / 2
            if (samples <= 0) return 0.0
            var total = 0.0
            for (index in 0 until samples) {
                val low = frame[index * 2].toInt() and 0xFF
                val high = frame[index * 2 + 1].toInt()
                val normalised = ((high shl 8) or low).toShort().toDouble() / 32768.0
                total += normalised * normalised
            }
            return sqrt(total / samples)
        }
    }
}

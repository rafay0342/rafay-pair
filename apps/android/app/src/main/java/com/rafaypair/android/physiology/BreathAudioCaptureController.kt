package com.rafaypair.android.physiology

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Microphone capture for breathing rhythm.
 *
 * Audio is consumed inside the read loop, converted to the three per-hop scalars
 * the estimator needs, and overwritten on the next read. Nothing writes audio to
 * disk, no encoder is instantiated, and no audio buffer crosses a network
 * boundary — the only thing that leaves this class is [AudioHopFeature] values,
 * from which no intelligible content is reconstructible.
 *
 * It runs only during an explicit breathing session the user started. There is no
 * background listening.
 */
class BreathAudioCaptureController(
    private val onHops: (List<AudioHopFeature>) -> Unit,
    private val onFailure: (String) -> Unit,
) {
    private val running = AtomicBoolean(false)
    private var record: AudioRecord? = null
    private var worker: Thread? = null

    /** Caller must hold RECORD_AUDIO; the screen requests it before starting. */
    @SuppressLint("MissingPermission")
    fun start() {
        if (running.get()) return

        val sampleRate = PhysiologyTuning.AUDIO_SAMPLE_RATE_HZ.toInt()
        val minBuffer = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBuffer <= 0) {
            onFailure("This device's microphone format is unsupported.")
            return
        }

        val recorder = try {
            AudioRecord(
                // UNPROCESSED where available gives the raw signal; the platform's
                // voice-communication processing would gate out breath as noise,
                // which is precisely the signal being measured.
                MediaRecorder.AudioSource.UNPROCESSED,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBuffer * 4,
            )
        } catch (error: IllegalArgumentException) {
            onFailure("The microphone could not be opened.")
            return
        }

        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            onFailure("The microphone could not be opened.")
            return
        }

        record = recorder
        running.set(true)
        recorder.startRecording()

        worker = thread(name = "rafaypair-breath-audio", isDaemon = true) {
            val hopSamples = PhysiologyTuning.AUDIO_HOP_SAMPLES
            val pcm = ShortArray(hopSamples * 4)
            // Samples left over from the previous read, so hop boundaries follow
            // the session clock rather than the read size.
            val carry = ArrayList<Double>(hopSamples * 8)
            var elapsedMs = 0.0

            while (running.get()) {
                val read = recorder.read(pcm, 0, pcm.size)
                if (read <= 0) continue
                for (index in 0 until read) carry.add(pcm[index] / 32_767.0)

                val whole = carry.size / hopSamples
                if (whole == 0) continue

                val consumed = DoubleArray(whole * hopSamples) { carry[it] }
                repeat(whole * hopSamples) { carry.removeAt(0) }

                val produced = AudioBreathingEstimator.extractHops(consumed, elapsedMs)
                elapsedMs += consumed.size * 1000.0 / PhysiologyTuning.AUDIO_SAMPLE_RATE_HZ
                if (produced.isNotEmpty()) onHops(produced)
            }
        }
    }

    fun stop() {
        if (!running.getAndSet(false)) return
        worker?.join(500)
        worker = null
        record?.let {
            runCatching { it.stop() }
            it.release()
        }
        record = null
    }
}

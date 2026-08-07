package com.rafaypair.android.physiology

import kotlin.math.abs
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Cross-platform physiology parity tests.
 *
 * These read the same JSON vectors that the TypeScript and Swift engines read. A
 * failure here means the Kotlin engine has diverged from the specifications in
 * `engines/`.
 */
class PhysiologyGoldenTest {
    private val tolerance = 1e-6
    private val json = Json { ignoreUnknownKeys = true }

    @Serializable
    private data class QualityVector(
        val score: Double,
        val band: String,
        val coverage: Double,
        val motion: Double,
        val periodicity: Double,
        val amplitude: Double,
        val stability: Double,
    )

    @Serializable
    private data class PulseExpectation(
        val status: String,
        val reason: String? = null,
        val bpm: Double? = null,
        val durationMs: Double,
        val sampleCount: Int,
        val effectiveSampleRateHz: Double? = null,
        val confidence: Double? = null,
        val confidenceBand: String? = null,
        val quality: QualityVector,
    )

    @Serializable
    private data class PulseVector(
        val name: String,
        val measuredAtMs: Double,
        val samples: List<List<Double>>,
        val expected: PulseExpectation,
    )

    @Serializable
    private data class BreathingExpectation(
        val status: String,
        val reason: String? = null,
        val breathsPerMinute: Double? = null,
        val durationMs: Double,
        val sampleCount: Int,
        val confidence: Double? = null,
        val confidenceBand: String? = null,
        val quality: QualityVector,
    )

    @Serializable
    private data class BreathingVector(
        val name: String,
        val measuredAtMs: Double,
        val samples: List<List<Double>>,
        val expected: BreathingExpectation,
    )

    @Serializable
    private data class CalorieBandVector(
        val lowKcal: Double,
        val highKcal: Double,
        val label: String,
    )

    @Serializable
    private data class CalorieExpectation(
        val estimatedKcal: Double,
        val algorithmVersion: String,
        val met: Double,
        val bodyMassKg: Double,
        val repetitions: Int,
        val inputsUsed: List<String>,
        val confidenceBand: CalorieBandVector,
    )

    @Serializable
    private data class CalorieInputVector(
        val activity: String,
        val durationMs: Double,
        val repetitions: Int? = null,
        val bodyMassKg: Double? = null,
        val poseConfidence: Double? = null,
    )

    @Serializable
    private data class CalorieCase(
        val name: String,
        val input: CalorieInputVector,
        val expected: CalorieExpectation,
    )

    @Serializable
    private data class CalorieVectors(val cases: List<CalorieCase>)

    private inline fun <reified T> loadVector(subdirectory: String, name: String): T {
        val path = "$subdirectory/$name.json"
        val stream = requireNotNull(javaClass.classLoader?.getResourceAsStream(path)) {
            "Missing golden vector $path on the test classpath"
        }
        return stream.use { json.decodeFromString<T>(it.reader().readText()) }
    }

    private fun assertQuality(actual: SignalQuality, expected: QualityVector, label: String) {
        assertEquals(label, expected.band, actual.band.wireName)
        assertEquals(label, expected.score, actual.score, tolerance)
        assertEquals(label, expected.coverage, actual.coverage, tolerance)
        assertEquals(label, expected.motion, actual.motion, tolerance)
        assertEquals(label, expected.periodicity, actual.periodicity, tolerance)
        assertEquals(label, expected.amplitude, actual.amplitude, tolerance)
        assertEquals(label, expected.stability, actual.stability, tolerance)
    }

    @Test
    fun pulseVectorsMatch() {
        for (name in PULSE_VECTORS) {
            val vector = loadVector<PulseVector>("pulse", name)
            val samples = vector.samples.map { PulseSample(it[0], it[1], it[2]) }
            val actual = PulseEstimator.estimate(samples, vector.measuredAtMs)

            assertEquals(name, vector.expected.status, actual.statusName)
            assertEquals(name, vector.expected.sampleCount, actual.sampleCount)
            assertEquals(name, vector.expected.durationMs, actual.durationMs, tolerance)
            assertQuality(actual.quality, vector.expected.quality, name)

            when (actual) {
                is PulseResult.Measured -> {
                    assertEquals(name, vector.expected.bpm!!, actual.bpm, tolerance)
                    assertEquals(
                        name, vector.expected.confidence!!, actual.confidence, tolerance,
                    )
                    assertEquals(
                        name, vector.expected.confidenceBand, actual.confidenceBand.wireName,
                    )
                    assertEquals(
                        name,
                        vector.expected.effectiveSampleRateHz!!,
                        actual.effectiveSampleRateHz,
                        tolerance,
                    )
                    // Provenance is structural; there is no variant that could
                    // carry a measured-grade reading.
                    assertEquals(name, "phone_camera_ppg", actual.source)
                    assertEquals(name, "app_estimated", actual.kind)
                }

                is PulseResult.Rejected ->
                    assertEquals(name, vector.expected.reason, actual.reason.wireName)
            }
        }
    }

    @Test
    fun pulseRecoversTheSynthesisedRateNotASubharmonic() {
        // The octave error is the failure mode that would fabricate a plausible
        // number, so the truth is asserted rather than mere self-consistency.
        val truths = mapOf(
            "clean-72bpm" to 72.0,
            "clean-58bpm" to 58.0,
            "post-exercise-124bpm" to 124.0,
            "low-perfusion-88bpm" to 88.0,
        )
        for ((name, truth) in truths) {
            val vector = loadVector<PulseVector>("pulse", name)
            val samples = vector.samples.map { PulseSample(it[0], it[1], it[2]) }
            val actual = PulseEstimator.estimate(samples, vector.measuredAtMs)
            assertTrue(name, actual is PulseResult.Measured)
            assertTrue(name, abs((actual as PulseResult.Measured).bpm - truth) < 2)
        }
    }

    @Test
    fun breathingVectorsMatch() {
        for (name in BREATHING_VECTORS) {
            val vector = loadVector<BreathingVector>("breathing", name)
            val samples = vector.samples.map { BreathingSample(it[0], it[1], it[2] == 1.0) }
            val actual = BreathingEstimator.estimate(samples, vector.measuredAtMs)

            assertEquals(name, vector.expected.status, actual.statusName)
            assertEquals(name, vector.expected.sampleCount, actual.sampleCount)
            assertQuality(actual.quality, vector.expected.quality, name)

            when (actual) {
                is BreathingResult.Measured -> {
                    assertEquals(
                        name,
                        vector.expected.breathsPerMinute!!,
                        actual.breathsPerMinute,
                        tolerance,
                    )
                    assertEquals(
                        name, vector.expected.confidenceBand, actual.confidenceBand.wireName,
                    )
                    assertEquals(name, "phone_camera_motion", actual.source)
                    assertEquals(name, "app_estimated", actual.kind)
                }

                is BreathingResult.Rejected ->
                    assertEquals(name, vector.expected.reason, actual.reason.wireName)
            }
        }
    }

    @Test
    fun calorieVectorsMatch() {
        val vectors = loadVector<CalorieVectors>("calories", "estimates")
        assertTrue(vectors.cases.isNotEmpty())

        for (testCase in vectors.cases) {
            val activity = requireNotNull(
                CalorieActivity.fromWireName(testCase.input.activity),
            ) { testCase.name }
            val actual = CalorieEstimator.estimate(
                CalorieEstimateInput(
                    activity = activity,
                    durationMs = testCase.input.durationMs,
                    repetitions = testCase.input.repetitions,
                    bodyMassKg = testCase.input.bodyMassKg,
                    poseConfidence = testCase.input.poseConfidence,
                ),
            )
            val expected = testCase.expected

            assertEquals(
                testCase.name, expected.estimatedKcal, actual.estimatedKcal, tolerance,
            )
            assertEquals(testCase.name, expected.met, actual.met, tolerance)
            assertEquals(testCase.name, expected.bodyMassKg, actual.bodyMassKg, tolerance)
            assertEquals(testCase.name, expected.repetitions, actual.repetitions)
            assertEquals(testCase.name, expected.algorithmVersion, actual.algorithmVersion)
            assertEquals(
                testCase.name, expected.inputsUsed, actual.inputsUsed.map { it.wireName },
            )
            assertEquals(
                testCase.name, expected.confidenceBand.label, actual.bandLabel.wireName,
            )
            assertEquals(
                testCase.name, expected.confidenceBand.lowKcal, actual.lowKcal, tolerance,
            )
            assertEquals(
                testCase.name, expected.confidenceBand.highKcal, actual.highKcal, tolerance,
            )
        }
    }

    @Serializable
    private data class AudioFrameVector(
        val name: String,
        val sampleRateHz: Int,
        val pcm: List<Double>,
        val expectedHops: List<List<Double>>,
    )

    @Serializable
    private data class AudioExpectation(
        val status: String,
        val reason: String? = null,
        val breathsPerMinute: Double? = null,
        val durationMs: Double,
        val hopCount: Int,
        val confidence: Double? = null,
        val confidenceBand: String? = null,
        val quality: QualityVector,
    )

    @Serializable
    private data class AudioSessionVector(
        val name: String,
        val measuredAtMs: Double,
        val hops: List<List<Double>>,
        val expected: AudioExpectation,
    )

    private fun List<List<Double>>.toHops(): List<AudioHopFeature> =
        map { AudioHopFeature(it[0], it[1], it[2], it[3]) }

    @Test
    fun microphoneFeatureExtractionMatches() {
        for (name in AUDIO_FRAME_VECTORS) {
            val vector = loadVector<AudioFrameVector>("breathing-audio/frames", name)
            // The vector stores PCM as 16-bit integers, which is what a device
            // delivers; the extractor takes floats in -1..1.
            val samples = DoubleArray(vector.pcm.size) { vector.pcm[it] / 32_767 }
            val hops = AudioBreathingEstimator.extractHops(samples, 0.0)

            assertEquals(name, vector.expectedHops.size, hops.size)
            hops.forEachIndexed { index, hop ->
                val expected = vector.expectedHops[index]
                assertEquals(name, expected[0], hop.timestampMs, tolerance)
                assertEquals(name, expected[1], hop.rms, tolerance)
                assertEquals(name, expected[2], hop.zeroCrossingRate, tolerance)
                assertEquals(name, expected[3], hop.peak, tolerance)
            }
        }
    }

    @Test
    fun clippedRecordingHasNoUsableHops() {
        val vector = loadVector<AudioFrameVector>("breathing-audio/frames", "clipped-input")
        val hops = vector.expectedHops.toHops()
        assertTrue(hops.isNotEmpty())
        assertTrue(hops.none { AudioBreathingEstimator.isHopUsable(it) })
    }

    @Test
    fun microphoneBreathingVectorsMatch() {
        for (name in AUDIO_SESSION_VECTORS) {
            val vector = loadVector<AudioSessionVector>("breathing-audio", name)
            val actual = AudioBreathingEstimator.estimate(
                vector.hops.toHops(), vector.measuredAtMs,
            )

            assertEquals(name, vector.expected.status, actual.statusName)
            assertEquals(name, vector.expected.hopCount, actual.hopCount)
            assertQuality(actual.quality, vector.expected.quality, name)

            when (actual) {
                is AudioBreathingResult.Measured -> {
                    assertEquals(
                        name,
                        vector.expected.breathsPerMinute!!,
                        actual.breathsPerMinute,
                        tolerance,
                    )
                    assertEquals(
                        name, vector.expected.confidenceBand, actual.confidenceBand.wireName,
                    )
                    assertEquals(name, "phone_microphone", actual.source)
                    assertEquals(name, "app_estimated", actual.kind)
                }

                is AudioBreathingResult.Rejected ->
                    assertEquals(name, vector.expected.reason, actual.reason.wireName)
            }
        }
    }

    @Test
    fun microphoneRecoversTheCycleNotTheBurstRate() {
        // Breath sound is loud on the inhale and again on the exhale, so a naive
        // peak search reports double. This is the assertion that catches it.
        val truths = mapOf("calm-11-breaths" to 11.0, "elevated-18-breaths" to 18.0)
        for ((name, truth) in truths) {
            val vector = loadVector<AudioSessionVector>("breathing-audio", name)
            val actual = AudioBreathingEstimator.estimate(
                vector.hops.toHops(), vector.measuredAtMs,
            )
            assertTrue(name, actual is AudioBreathingResult.Measured)
            assertTrue(
                name,
                abs((actual as AudioBreathingResult.Measured).breathsPerMinute - truth) < 1,
            )
        }
    }

    @Test
    fun guidedBreathingSchedule() {
        val calm = BreathingPattern.calm(3)
        // Calm has no hold phases, so they must be skipped rather than reported.
        assertEquals(BreathingPhase.INHALE, BreathingEstimator.phaseAt(calm, 0.0).phase)
        assertEquals(BreathingPhase.INHALE, BreathingEstimator.phaseAt(calm, 3_999.0).phase)
        assertEquals(BreathingPhase.EXHALE, BreathingEstimator.phaseAt(calm, 4_000.0).phase)
        assertEquals(1, BreathingEstimator.phaseAt(calm, 10_000.0).cycleIndex)
        assertEquals(
            BreathingPhase.COMPLETE, BreathingEstimator.phaseAt(calm, 30_000.0).phase,
        )

        val box = BreathingPattern.box(1)
        assertEquals(BreathingPhase.HOLD, BreathingEstimator.phaseAt(box, 6_000.0).phase)
        assertEquals(BreathingPhase.EXHALE, BreathingEstimator.phaseAt(box, 10_000.0).phase)
        assertEquals(
            BreathingPhase.HOLD_AFTER, BreathingEstimator.phaseAt(box, 14_000.0).phase,
        )
        assertEquals(0.5, BreathingEstimator.phaseAt(box, 2_000.0).progress, tolerance)
    }

    @Test
    fun pulseFreshnessExpiresAtTheWindow() {
        val pulse = PulseResult.Measured(
            bpm = 72.0,
            durationMs = 20_000.0,
            sampleCount = 600,
            effectiveSampleRateHz = 30.0,
            quality = SignalQuality.EMPTY,
            confidence = 0.9,
            confidenceBand = ConfidenceBand.HIGH,
            measuredAtMs = 1_000_000.0,
        )
        assertTrue(PulseFreshness.isFresh(pulse, 1_000_000.0))
        assertTrue(
            PulseFreshness.isFresh(
                pulse, 1_000_000.0 + PhysiologyTuning.PULSE_FRESHNESS_MS - 1,
            ),
        )
        // Master specification §4: an expired reading stops being current
        // everywhere, including for a partner.
        assertTrue(
            !PulseFreshness.isFresh(
                pulse, 1_000_000.0 + PhysiologyTuning.PULSE_FRESHNESS_MS,
            ),
        )
        assertEquals(0.0, PulseFreshness.ageMs(pulse, 999_000.0), tolerance)
    }

    private companion object {
        val PULSE_VECTORS = listOf(
            "clean-58bpm",
            "clean-72bpm",
            "finger-lifted",
            "low-perfusion-88bpm",
            "no-pulsation",
            "post-exercise-124bpm",
            "short-session",
            "sliding-finger",
        )

        val AUDIO_FRAME_VECTORS = listOf("clipped-input", "steady-breathing")

        val AUDIO_SESSION_VECTORS = listOf(
            "calm-11-breaths",
            "elevated-18-breaths",
            "session-too-short",
            "silent-room",
            "voiced-speech-intrusion",
        )

        val BREATHING_VECTORS = listOf(
            "calm-12-breaths",
            "elevated-20-breaths",
            "fidgeting-but-recoverable",
            "gross-body-movement",
            "poorly-tracked",
            "session-too-short",
            "slow-8-breaths",
        )
    }
}

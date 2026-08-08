package com.rafaypair.android.data.network

import kotlin.math.PI
import kotlin.math.sin
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The same committed vectors the TypeScript and Swift ports consume.
 *
 * Three implementations reaching the same verdict on the same synthesised audio
 * is what parity means here.
 */
class SpeakerProfileGoldenTest {
    @Serializable
    private data class SpeakerCase(
        val name: String,
        val note: String,
        val enrolF0: Double,
        val speakF0: Double,
        val frames: Int,
        val expected: String,
    )

    @Serializable
    private data class SpeakerVectors(
        val amplitude: Double,
        val samplesPerFrame: Int,
        val wobbleHz: Int,
        val enrolFrames: Int,
        val cases: List<SpeakerCase>,
    )

    private val json = Json { ignoreUnknownKeys = true }

    /** The test signal, exactly as `engines/speaker-profile/SPEC.md` defines it. */
    private fun frame(f0Hz: Double, amplitude: Double, samples: Int): DoubleArray =
        DoubleArray(samples) { index ->
            val t = index / 16_000.0
            amplitude * (
                sin(2 * PI * f0Hz * t) +
                    0.5 * sin(2 * PI * 2 * f0Hz * t) +
                    0.25 * sin(2 * PI * 3 * f0Hz * t)
                )
        }

    private fun wobble(base: Double, index: Int, wobbleHz: Int): Double =
        base + ((index % (wobbleHz * 2 + 1)) - wobbleHz)

    @Test
    fun `matches the golden vectors`() {
        val path = "speaker-profile/vectors.json"
        val stream = requireNotNull(javaClass.classLoader?.getResourceAsStream(path)) {
            "Missing golden vector $path on the test classpath"
        }
        val vectors = stream.use { json.decodeFromString<SpeakerVectors>(it.reader().readText()) }
        assertTrue(vectors.cases.isNotEmpty())

        vectors.cases.forEach { entry ->
            val enrolment = (0 until vectors.enrolFrames).mapNotNull { index ->
                SpeakerFeatures.frame(
                    frame(
                        wobble(entry.enrolF0, index, vectors.wobbleHz),
                        vectors.amplitude,
                        vectors.samplesPerFrame,
                    ),
                )
            }
            val profile = SpeakerFeatures.profile(enrolment)
            assertNotNull(entry.note, profile)

            val matcher = SpeakerMatcher(profile)
            var verdict = SpeakerVerdict.UNKNOWN
            repeat(entry.frames) { index ->
                verdict = matcher.accept(
                    SpeakerFeatures.frame(
                        frame(
                            wobble(entry.speakF0, index, vectors.wobbleHz),
                            vectors.amplitude,
                            vectors.samplesPerFrame,
                        ),
                    ),
                ).verdict
            }
            assertEquals("${entry.name}: ${entry.note}", entry.expected, verdict.wireName)
        }
    }
}

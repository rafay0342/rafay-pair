package com.rafaypair.android.data.network

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The same committed vectors the TypeScript and Swift ports consume.
 *
 * Three independent implementations agreeing on data is what parity means here;
 * agreeing on prose is not.
 */
class SpeechGateGoldenTest {
    @Serializable
    private data class GateCase(
        val name: String,
        val note: String,
        val levels: List<Double>,
        val transmit: List<Boolean>,
    )

    @Serializable
    private data class GateVectors(val cases: List<GateCase>)

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `matches the golden vectors`() {
        val path = "speech-gate/vectors.json"
        val stream = requireNotNull(javaClass.classLoader?.getResourceAsStream(path)) {
            "Missing golden vector $path on the test classpath"
        }
        val vectors = stream.use { json.decodeFromString<GateVectors>(it.reader().readText()) }
        assertTrue(vectors.cases.isNotEmpty())

        vectors.cases.forEach { entry ->
            val gate = SpeechGate()
            val actual = entry.levels.map { gate.accept(it).transmit }
            assertEquals("${entry.name}: ${entry.note}", entry.transmit, actual)
        }
    }
}

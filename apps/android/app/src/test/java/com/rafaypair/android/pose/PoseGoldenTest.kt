package com.rafaypair.android.pose

import kotlin.math.abs
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Cross-platform parity tests.
 *
 * These read the same JSON vectors that the TypeScript and Swift engines read.
 * If this suite fails, the Kotlin engine has diverged from
 * `engines/pose-spec/SPEC.md` or `engines/exercise-state-machines/SPEC.md`.
 */
class PoseGoldenTest {
    /**
     * Continuous values are compared with the tolerance the specifications
     * mandate: `atan2` is not guaranteed bit-identical across math libraries.
     */
    private val tolerance = 1e-6

    private val json = Json { ignoreUnknownKeys = true }

    @Serializable
    private data class PackedFrame(val t: Double, val j: List<Double>)

    @Serializable
    private data class PoseExpectation(
        val valid: Boolean,
        val posture: String,
        val framingOk: Boolean,
        val torsoAngleDeg: Double,
        val meanKneeAngle: Double,
        val meanHipAngle: Double,
        val hipElevation: Double,
        val minVisibility: Double,
    )

    @Serializable
    private data class PoseCase(
        val name: String,
        val note: String,
        val frame: PackedFrame,
        val expected: PoseExpectation,
    )

    @Serializable
    private data class PoseVectors(val cases: List<PoseCase>)

    @Serializable
    private data class RepetitionExpectation(
        val index: Int,
        val startMs: Double,
        val endMs: Double,
        val durationMs: Double,
        val minElevation: Double,
        val depth: Double,
        val formEvents: List<String>,
    )

    @Serializable
    private data class ExerciseExpectation(
        val repetitionCount: Int,
        val finalReportedPosture: String,
        val repetitions: List<RepetitionExpectation>,
    )

    @Serializable
    private data class ExerciseCase(
        val name: String,
        val note: String,
        val frames: List<PackedFrame>,
        val expected: ExerciseExpectation,
    )

    private fun decode(packed: PackedFrame): PoseFrame {
        val expectedValues = JointName.ALL.size * 3
        assertEquals("Golden frame value count", expectedValues, packed.j.size)
        val joints = JointName.ALL.indices.map { index ->
            val offset = index * 3
            Joint(packed.j[offset], packed.j[offset + 1], packed.j[offset + 2])
        }
        return PoseFrame(packed.timestamp(), joints)
    }

    private fun PackedFrame.timestamp(): Double = t

    private inline fun <reified T> loadVector(subdirectory: String, name: String): T {
        val path = "$subdirectory/$name.json"
        val stream = requireNotNull(javaClass.classLoader?.getResourceAsStream(path)) {
            "Missing golden vector $path on the test classpath"
        }
        return stream.use { json.decodeFromString<T>(it.reader().readText()) }
    }

    @Test
    fun staticPostureVectorsMatch() {
        val vectors = loadVector<PoseVectors>("pose", "static-postures")
        assertTrue(vectors.cases.isNotEmpty())

        for (testCase in vectors.cases) {
            val engine = PoseEngine()
            val observation = engine.process(decode(testCase.frame))
            val expected = testCase.expected

            assertEquals(testCase.name, expected.valid, observation.valid)
            assertEquals(testCase.name, expected.posture, observation.posture.wireName)
            assertEquals(testCase.name, expected.framingOk, observation.framingOk)
            assertEquals(
                testCase.name,
                expected.torsoAngleDeg,
                observation.torsoAngleDeg,
                tolerance,
            )
            assertEquals(
                testCase.name,
                expected.meanKneeAngle,
                observation.meanKneeAngle,
                tolerance,
            )
            assertEquals(
                testCase.name,
                expected.meanHipAngle,
                observation.meanHipAngle,
                tolerance,
            )
            assertEquals(
                testCase.name,
                expected.hipElevation,
                observation.hipElevation,
                tolerance,
            )
            assertEquals(
                testCase.name,
                expected.minVisibility,
                observation.minVisibility,
                tolerance,
            )
        }
    }

    @Test
    fun staticVectorsCoverEveryClassification() {
        val vectors = loadVector<PoseVectors>("pose", "static-postures")
        assertEquals(
            setOf("standing", "crouched", "lying", "transitional", "unknown"),
            vectors.cases.map { it.expected.posture }.toSet(),
        )
    }

    @Test
    fun exerciseVectorsMatch() {
        for (name in EXERCISE_VECTORS) {
            val testCase = loadVector<ExerciseCase>("exercise", name)
            val poseEngine = PoseEngine()
            val exerciseEngine = ExerciseEngine()

            var finalReportedPosture = ReportedPosture.UNKNOWN
            for (frame in testCase.frames) {
                val observation = poseEngine.process(decode(frame))
                finalReportedPosture = exerciseEngine.process(observation).reportedPosture
            }

            val summary = exerciseEngine.summary()
            assertEquals(name, testCase.expected.repetitionCount, summary.repetitionCount)
            assertEquals(
                name,
                testCase.expected.finalReportedPosture,
                finalReportedPosture.wireName,
            )
            assertEquals(
                name,
                testCase.expected.repetitions.size,
                summary.repetitions.size,
            )

            summary.repetitions.zip(testCase.expected.repetitions).forEach { (actual, expected) ->
                assertEquals(name, expected.index, actual.index)
                assertEquals(name, expected.startMs, actual.startMs, tolerance)
                assertEquals(name, expected.endMs, actual.endMs, tolerance)
                assertEquals(name, expected.durationMs, actual.durationMs, tolerance)
                assertEquals(name, expected.minElevation, actual.minElevation, tolerance)
                assertEquals(name, expected.depth, actual.depth, tolerance)
                assertEquals(name, expected.formEvents, actual.formEvents.map { it.wireName })
            }
        }
    }

    @Test
    fun resetMakesReplayReproducible() {
        val testCase = loadVector<ExerciseCase>("exercise", "three-squats")
        val engine = PoseEngine()
        val first = testCase.frames.map { engine.process(decode(it)).hipElevation }
        engine.reset()
        val second = testCase.frames.map { engine.process(decode(it)).hipElevation }
        assertEquals(first, second)
    }

    @Test
    fun staleGapDropsCommittedPosture() {
        val testCase = loadVector<ExerciseCase>("exercise", "three-squats")
        val poseEngine = PoseEngine()
        val exerciseEngine = ExerciseEngine()
        val frames = testCase.frames.take(40)
        for (frame in frames) {
            exerciseEngine.process(poseEngine.process(decode(frame)))
        }

        // A gap longer than the stale threshold must drop the committed posture
        // rather than carrying a stale claim across the interruption.
        val last = frames.last()
        val resumedFrame = decode(last).copy(timestampMs = last.t + 5_000)
        val resumed = exerciseEngine.process(poseEngine.process(resumedFrame))
        assertEquals(ReportedPosture.UNKNOWN, resumed.reportedPosture)
    }

    @Test
    fun partialSquatNeverCompletesARepetition() {
        val testCase = loadVector<ExerciseCase>("exercise", "partial-squat-no-depth")
        val poseEngine = PoseEngine()
        val exerciseEngine = ExerciseEngine()
        for (frame in testCase.frames) {
            val result = exerciseEngine.process(poseEngine.process(decode(frame)))
            assertNull(result.completedRepetition)
        }
    }

    @Test
    fun smoothingUsesTheSpecifiedCoefficient() {
        // The smoothing filter is the only engine state a port could get wrong
        // while still passing every scenario vector, because the vectors move
        // slowly enough to mask a wrong coefficient in the discrete outputs.
        val testCase = loadVector<ExerciseCase>("exercise", "three-squats")
        val frames = testCase.frames.take(2).map { decode(it) }
        val engine = PoseEngine()
        engine.process(frames[0])
        val smoothedSecond = engine.process(frames[1])

        val alpha = PoseTuning.SMOOTHING_ALPHA
        val blended = PoseFrame(
            timestampMs = frames[1].timestampMs,
            joints = frames[1].joints.mapIndexed { index, joint ->
                Joint(
                    x = alpha * joint.x + (1 - alpha) * frames[0].joints[index].x,
                    y = alpha * joint.y + (1 - alpha) * frames[0].joints[index].y,
                    visibility = joint.visibility,
                )
            },
        )
        val unsmoothed = PoseEngine().process(blended)

        assertEquals(unsmoothed.hipElevation, smoothedSecond.hipElevation, tolerance)
        assertEquals(unsmoothed.meanKneeAngle, smoothedSecond.meanKneeAngle, tolerance)
    }

    private companion object {
        val EXERCISE_VECTORS = listOf(
            "bounce-too-fast",
            "deep-squat-forward-lean",
            "lie-down-and-hold",
            "partial-squat-no-depth",
            "sit-down-and-hold",
            "squat-then-sit",
            "standing-still",
            "three-squats",
        )
    }
}

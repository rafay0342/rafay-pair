package com.rafaypair.android.experiments

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Master specification §24, and parity with `packages/experiment-flags`.
 *
 * The names are checked rather than described so a flag cannot be quietly
 * dropped or renamed on one platform only.
 */
class ExperimentFlagsTest {
    @Test
    fun `declares exactly the six the specification names, in order`() {
        assertEquals(
            listOf(
                "camera_ppg_face_mode",
                "camera_breathing_estimate",
                "microphone_breathing_estimate",
                "advanced_form_coaching",
                "living_body_advanced",
                "ai_relationship_memory",
            ),
            ExperimentFlag.entries.map { it.wireName },
        )
    }

    @Test
    fun `no experiment is enabled by default`() {
        // "No experimental physiological feature may be enabled silently." A
        // default of true would make that sentence false, whatever the screen does.
        ExperimentFlag.entries.forEach { flag ->
            assertFalse(flag.wireName, flag.enabledByDefault)
        }
    }

    @Test
    fun `the physiological ones are marked as such`() {
        assertTrue(ExperimentFlag.CAMERA_PPG_FACE_MODE.isPhysiological)
        assertTrue(ExperimentFlag.CAMERA_BREATHING_ESTIMATE.isPhysiological)
        assertTrue(ExperimentFlag.MICROPHONE_BREATHING_ESTIMATE.isPhysiological)
        assertFalse(ExperimentFlag.LIVING_BODY_ADVANCED.isPhysiological)
    }

    @Test
    fun `an unknown name resolves to nothing rather than to a flag`() {
        assertNull(ExperimentFlag.fromWire("from_a_newer_build"))
        assertEquals(
            ExperimentFlag.CAMERA_BREATHING_ESTIMATE,
            ExperimentFlag.fromWire("camera_breathing_estimate"),
        )
    }

    @Test
    fun `every entry explains itself`() {
        ExperimentFlag.entries.forEach { flag ->
            assertTrue(flag.wireName, flag.title.isNotEmpty())
            assertTrue(flag.wireName, flag.detail.length > 40)
        }
    }
}

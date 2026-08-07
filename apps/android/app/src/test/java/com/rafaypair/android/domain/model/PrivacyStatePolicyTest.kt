package com.rafaypair.android.domain.model

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrivacyStatePolicyTest {
    private val ownerId = "58b78358-88f5-4b6e-a337-c729750f179f"
    private val pairId = "05ab21dd-52bb-463b-851c-683154f47c85"

    @Test
    fun `sharing requires an exact confirmed unpaused scope`() {
        val confirmed = PrivacyState(
            ownerUserId = ownerId,
            pairId = pairId,
            isPaused = false,
            desiredPaused = false,
            syncPending = false,
            boundaryReady = true,
        )

        assertTrue(confirmed.allowsSharing(ownerId, pairId))
        assertFalse(confirmed.allowsSharing("129b05c9-145c-4f5b-ad3d-66f41cd31f26", pairId))
        assertFalse(confirmed.allowsSharing(ownerId, "f5f16b31-b258-4bed-9367-401d40c01e74"))
    }

    @Test
    fun `sharing fails closed for missing boundary pause or pending confirmation`() {
        val confirmed = PrivacyState(
            ownerUserId = ownerId,
            pairId = pairId,
            isPaused = false,
            desiredPaused = false,
            syncPending = false,
            boundaryReady = true,
        )

        assertFalse(PrivacyState().allowsSharing(ownerId, pairId))
        assertFalse(confirmed.copy(boundaryReady = false).allowsSharing(ownerId, pairId))
        assertFalse(confirmed.copy(isPaused = true, desiredPaused = true).allowsSharing(ownerId, pairId))
        assertFalse(confirmed.copy(syncPending = true).allowsSharing(ownerId, pairId))
    }
}

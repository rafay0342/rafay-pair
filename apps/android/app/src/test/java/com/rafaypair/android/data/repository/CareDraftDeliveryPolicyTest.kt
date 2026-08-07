package com.rafaypair.android.data.repository

import com.rafaypair.android.domain.model.PairDetails
import com.rafaypair.android.domain.model.PairStatus
import com.rafaypair.android.domain.model.Partner
import java.time.Instant
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CareDraftDeliveryPolicyTest {
    private val activePair = PairDetails(
        id = "pair-original",
        status = PairStatus.ACTIVE,
        joinCode = null,
        partner = Partner("partner-1", "Partner"),
        createdAt = Instant.EPOCH,
    )

    @Test
    fun `allows delivery only for the signed-in owner and original active pair`() {
        assertTrue(
            CareDraftDeliveryPolicy.canDeliver(
                draftOwnerId = "owner-1",
                draftPairId = "pair-original",
                currentOwnerId = "owner-1",
                currentPair = activePair,
            ),
        )
    }

    @Test
    fun `blocks a draft after account switch`() {
        assertFalse(
            CareDraftDeliveryPolicy.canDeliver(
                draftOwnerId = "owner-1",
                draftPairId = "pair-original",
                currentOwnerId = "owner-2",
                currentPair = activePair,
            ),
        )
    }

    @Test
    fun `blocks a draft from a previous pair`() {
        assertFalse(
            CareDraftDeliveryPolicy.canDeliver(
                draftOwnerId = "owner-1",
                draftPairId = "pair-original",
                currentOwnerId = "owner-1",
                currentPair = activePair.copy(id = "pair-new"),
            ),
        )
    }

    @Test
    fun `blocks delivery while the original pair is not active`() {
        assertFalse(
            CareDraftDeliveryPolicy.canDeliver(
                draftOwnerId = "owner-1",
                draftPairId = "pair-original",
                currentOwnerId = "owner-1",
                currentPair = activePair.copy(status = PairStatus.WAITING_FOR_PARTNER),
            ),
        )
        assertFalse(
            CareDraftDeliveryPolicy.canDeliver(
                draftOwnerId = "owner-1",
                draftPairId = "pair-original",
                currentOwnerId = "owner-1",
                currentPair = null,
            ),
        )
    }
}

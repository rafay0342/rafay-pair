package com.rafaypair.android

import com.rafaypair.android.data.local.CarePushPolicy
import com.rafaypair.android.data.repository.PushTokenPolicy
import com.rafaypair.android.notifications.PushWakePolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PushNotificationPolicyTest {
    @Test
    fun `only the exact contentless care wake is accepted`() {
        assertTrue(PushWakePolicy.accepts(mapOf("sync" to "care")))
        assertFalse(PushWakePolicy.accepts(mapOf("sync" to "care", "message" to "private content")))
        assertFalse(PushWakePolicy.accepts(mapOf("sync" to "profile")))
        assertFalse(PushWakePolicy.accepts(emptyMap()))
    }

    @Test
    fun `visible notification decision requires an unseen server result`() {
        assertEquals(
            listOf("request-new"),
            CarePushPolicy.unseenPendingIds(
                pendingIds = listOf("request-new", "request-seen"),
                seenIds = listOf("request-seen"),
            ),
        )
        assertTrue(
            CarePushPolicy.unseenPendingIds(
                pendingIds = listOf("request-seen"),
                seenIds = listOf("request-seen"),
            ).isEmpty(),
        )
    }

    @Test
    fun `firebase installation target validation rejects malformed values`() {
        assertTrue(PushTokenPolicy.isValid("cdefghijklmnopqrstuvwxyz123456"))
        assertFalse(PushTokenPolicy.isValid("short"))
        assertFalse(PushTokenPolicy.isValid("contains whitespace and is long"))
    }
}

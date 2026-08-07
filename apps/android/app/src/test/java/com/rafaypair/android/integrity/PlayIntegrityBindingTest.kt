package com.rafaypair.android.integrity

import org.junit.Assert.assertEquals
import org.junit.Test

class PlayIntegrityBindingTest {
    @Test
    fun `request binding matches the backend canonical SHA-256 vector`() {
        assertEquals(
            "g6LSFfKKxcAjvDrNb64OCWOe9XAhzZuXPiTD0xYu30s",
            PlayIntegrityCoordinator.requestHash(
                "00000000-0000-4000-8000-000000000123",
                "session_start",
            ),
        )
    }
}

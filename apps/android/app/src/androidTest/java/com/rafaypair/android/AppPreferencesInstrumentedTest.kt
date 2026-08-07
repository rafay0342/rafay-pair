package com.rafaypair.android

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.rafaypair.android.data.local.AccountPairScope
import com.rafaypair.android.data.local.AppPreferences
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AppPreferencesInstrumentedTest {
    private lateinit var preferences: AppPreferences

    @Before
    fun setUp() = runBlocking {
        preferences = AppPreferences(ApplicationProvider.getApplicationContext())
        preferences.clearAccountState()
    }

    @After
    fun tearDown() = runBlocking {
        preferences.clearAccountState()
    }

    @Test
    fun accountAndPairStateIsExactScopedFailClosedAndMonotonic() = runBlocking {
        val accountA = "58b78358-88f5-4b6e-a337-c729750f179f"
        val accountB = "129b05c9-145c-4f5b-ad3d-66f41cd31f26"
        val pairA = "05ab21dd-52bb-463b-851c-683154f47c85"
        val pairB = "f5f16b31-b258-4bed-9367-401d40c01e74"
        val scopeA = AccountPairScope(accountA, pairA)
        val scopeB = AccountPairScope(accountB, pairB)

        preferences.activateAccount(accountA)
        assertTrue(preferences.bindPairScope(scopeA))
        assertFalse(preferences.privacyState(scopeA).allowsSharing(accountA, pairA))
        assertTrue(preferences.confirmPrivacy(scopeA, paused = false))
        assertTrue(preferences.setRealtimeCursor(scopeA, "41"))
        assertFalse(preferences.setRealtimeCursor(scopeA, "41"))
        assertFalse(preferences.setRealtimeCursor(scopeA, "40"))
        assertEquals("41", preferences.realtimeCursor(scopeA))
        assertTrue(preferences.privacyState(scopeA).allowsSharing(accountA, pairA))

        preferences.activateAccount(accountB)

        assertFalse(preferences.privacyState(scopeA).allowsSharing(accountA, pairA))
        assertNull(preferences.realtimeCursor(scopeA))
        assertFalse(preferences.confirmPrivacy(scopeA, paused = false))
        assertFalse(preferences.setRealtimeCursor(scopeA, "42"))

        assertTrue(preferences.bindPairScope(scopeB))
        val initialB = preferences.privacyState(scopeB)
        assertTrue(initialB.isPaused)
        assertFalse(initialB.boundaryReady)
        assertFalse(initialB.allowsSharing(accountB, pairB))
        assertTrue(preferences.confirmPrivacy(scopeB, paused = false))
        assertTrue(preferences.setRealtimeCursor(scopeB, "1"))

        assertTrue(preferences.invalidatePairScope(scopeB))
        assertFalse(preferences.privacyState(scopeB).allowsSharing(accountB, pairB))
        assertNull(preferences.realtimeCursor(scopeB))
    }
}

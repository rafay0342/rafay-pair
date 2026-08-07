package com.rafaypair.android

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.rafaypair.android.data.local.RotatingTokenVault
import com.rafaypair.android.domain.model.AuthTokens
import com.rafaypair.android.domain.model.User
import java.time.Instant
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SecureStorageInstrumentedTest {
    private lateinit var vault: RotatingTokenVault

    @Before
    fun setUp() {
        vault = RotatingTokenVault(ApplicationProvider.getApplicationContext(), Json)
        vault.clear()
    }

    @After
    fun tearDown() {
        vault.clear()
    }

    @Test
    fun tokenPairRoundTripsOnlyThroughKeystoreCiphertext() {
        val user = User("58b78358-88f5-4b6e-a337-c729750f179f", "rafay@example.com", "Rafay")
        val tokens = AuthTokens(
            accessToken = "access-secret",
            refreshToken = "refresh-secret",
            accessTokenExpiresAt = Instant.parse("2030-01-01T00:00:00Z"),
            refreshTokenExpiresAt = Instant.parse("2030-02-01T00:00:00Z"),
            userId = user.id,
        )

        vault.save(user, tokens)
        val restored = requireNotNull(vault.read())
        val rawPreferences = ApplicationProvider.getApplicationContext<android.content.Context>()
            .getSharedPreferences("rafaypair.secure.session", android.content.Context.MODE_PRIVATE)
            .all
            .values
            .joinToString()

        assertEquals(tokens, restored.tokens)
        assertEquals(user, restored.user)
        assertFalse(rawPreferences.contains("access-secret"))
        assertFalse(rawPreferences.contains("refresh-secret"))
    }
}

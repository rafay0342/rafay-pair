package com.rafaypair.android

import com.rafaypair.android.domain.model.SessionState
import com.rafaypair.android.domain.repository.AuthRepository
import com.rafaypair.android.domain.usecase.LoginUseCase
import com.rafaypair.android.domain.usecase.RegisterUseCase
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

class UseCasesTest {
    @Test
    fun `login normalizes email before repository boundary`() = runTest {
        val repository = RecordingAuthRepository()
        LoginUseCase(repository)("  Person@Example.COM ", "secret")
        assertEquals("person@example.com", repository.email)
        assertEquals("secret", repository.password)
    }

    @Test
    fun `register trims user controlled identity values`() = runTest {
        val repository = RecordingAuthRepository()
        RegisterUseCase(repository)("  Rafay  ", " PERSON@Example.COM ", "correct-horse-42")
        assertEquals("Rafay", repository.displayName)
        assertEquals("person@example.com", repository.email)
    }

    private class RecordingAuthRepository : AuthRepository {
        override val session: StateFlow<SessionState> = MutableStateFlow(SessionState.SignedOut)
        var displayName: String? = null
        var email: String? = null
        var password: String? = null

        override suspend fun restore() = Unit

        override suspend fun register(displayName: String, email: String, password: String) {
            this.displayName = displayName
            this.email = email
            this.password = password
        }

        override suspend fun login(email: String, password: String) {
            this.email = email
            this.password = password
        }

        override suspend fun logout() = Unit
        override suspend fun refreshAccessToken(): Boolean = true
    }
}

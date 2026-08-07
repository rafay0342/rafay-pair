package com.rafaypair.android.data.repository

import com.rafaypair.android.domain.model.CareItem
import com.rafaypair.android.domain.model.CareKind
import com.rafaypair.android.domain.model.CareResponse
import com.rafaypair.android.domain.model.PairDetails
import com.rafaypair.android.domain.model.PairStatus
import com.rafaypair.android.domain.model.PrivacyState
import com.rafaypair.android.domain.model.SessionState
import com.rafaypair.android.domain.model.User
import com.rafaypair.android.domain.repository.AuthRepository
import com.rafaypair.android.domain.repository.CareRepository
import com.rafaypair.android.domain.repository.PairRepository
import com.rafaypair.android.domain.repository.PartnerReplayReadiness
import com.rafaypair.android.domain.repository.PrivacyRepository
import java.time.Instant
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReconnectSyncCoordinatorTest {
    @Test
    fun `restores session then confirms privacy before replaying care`() = runTest {
        val calls = mutableListOf<String>()
        val auth = FakeAuthRepository(calls, SessionState.Restoring)
        val pair = FakePairRepository(calls, activePair())
        val privacy = FakePrivacyRepository(calls, PartnerReplayReadiness.ALLOWED)
        val care = FakeCareRepository(calls)

        val result = ReconnectSyncCoordinator(auth, pair, privacy, care).synchronizePrivacyThenCare()

        assertTrue(result)
        assertEquals(
            listOf("auth.restore", "pair.refresh", "privacy.prepare", "care.sync"),
            calls,
        )
    }

    @Test
    fun `confirmed pause blocks queued care without retrying the worker`() = runTest {
        val calls = mutableListOf<String>()
        val auth = FakeAuthRepository(calls, signedIn())
        val pair = FakePairRepository(calls, activePair())
        val privacy = FakePrivacyRepository(calls, PartnerReplayReadiness.BLOCKED)
        val care = FakeCareRepository(calls)

        val result = ReconnectSyncCoordinator(auth, pair, privacy, care).synchronizePrivacyThenCare()

        assertTrue(result)
        assertEquals(listOf("pair.refresh", "privacy.prepare"), calls)
        assertEquals(0, care.syncCount)
    }

    @Test
    fun `unconfirmed privacy retries without touching queued care`() = runTest {
        val calls = mutableListOf<String>()
        val auth = FakeAuthRepository(calls, signedIn())
        val pair = FakePairRepository(calls, activePair())
        val privacy = FakePrivacyRepository(calls, PartnerReplayReadiness.RETRY)
        val care = FakeCareRepository(calls)

        val result = ReconnectSyncCoordinator(auth, pair, privacy, care).synchronizePrivacyThenCare()

        assertFalse(result)
        assertEquals(listOf("pair.refresh", "privacy.prepare"), calls)
        assertEquals(0, care.syncCount)
    }

    @Test
    fun `missing active pair clears the privacy boundary and never replays care`() = runTest {
        val calls = mutableListOf<String>()
        val auth = FakeAuthRepository(calls, signedIn())
        val pair = FakePairRepository(calls, null)
        val privacy = FakePrivacyRepository(calls, PartnerReplayReadiness.ALLOWED)
        val care = FakeCareRepository(calls)

        val result = ReconnectSyncCoordinator(auth, pair, privacy, care).synchronizePrivacyThenCare()

        assertTrue(result)
        assertEquals(listOf("pair.refresh", "privacy.bind"), calls)
        assertEquals(0, care.syncCount)
    }

    @Test
    fun `concurrent workers share one serialized replay boundary`() = runTest {
        val calls = mutableListOf<String>()
        var activeRefreshes = 0
        var maximumActiveRefreshes = 0
        val auth = FakeAuthRepository(calls, signedIn())
        val pair = FakePairRepository(calls, activePair()) {
            activeRefreshes += 1
            maximumActiveRefreshes = maxOf(maximumActiveRefreshes, activeRefreshes)
            delay(10)
            activeRefreshes -= 1
        }
        val privacy = FakePrivacyRepository(calls, PartnerReplayReadiness.BLOCKED)
        val care = FakeCareRepository(calls)
        val coordinator = ReconnectSyncCoordinator(auth, pair, privacy, care)

        val first = async { coordinator.synchronizePrivacyThenCare() }
        val second = async { coordinator.synchronizePrivacyThenCare() }

        assertTrue(first.await())
        assertTrue(second.await())
        assertEquals(1, maximumActiveRefreshes)
        assertEquals(0, care.syncCount)
    }

    private class FakeAuthRepository(
        private val calls: MutableList<String>,
        initial: SessionState,
    ) : AuthRepository {
        private val mutableSession = MutableStateFlow(initial)
        override val session: StateFlow<SessionState> = mutableSession

        override suspend fun restore() {
            calls += "auth.restore"
            mutableSession.value = signedIn()
        }

        override suspend fun register(displayName: String, email: String, password: String) = Unit
        override suspend fun login(email: String, password: String) = Unit
        override suspend fun logout() = Unit
        override suspend fun refreshAccessToken(): Boolean = true
    }

    private class FakePairRepository(
        private val calls: MutableList<String>,
        initial: PairDetails?,
        private val onRefresh: suspend () -> Unit = {},
    ) : PairRepository {
        override val pair: StateFlow<PairDetails?> = MutableStateFlow(initial)
        override val loading: StateFlow<Boolean> = MutableStateFlow(false)

        override suspend fun refresh() {
            calls += "pair.refresh"
            onRefresh()
        }

        override suspend fun create() = Unit
        override suspend fun join(code: String) = Unit
        override suspend fun disconnect() = Unit
        override fun clear() = Unit
    }

    private class FakePrivacyRepository(
        private val calls: MutableList<String>,
        private val readiness: PartnerReplayReadiness,
    ) : PrivacyRepository {
        override val state: StateFlow<PrivacyState> = MutableStateFlow(PrivacyState())

        override suspend fun bindCurrentScope(): Boolean {
            calls += "privacy.bind"
            return true
        }

        override suspend fun refresh() = Unit
        override suspend fun pause() = Unit
        override suspend fun resume() = Unit
        override suspend fun syncPending(): Boolean = true

        override suspend fun prepareForPartnerReplay(): PartnerReplayReadiness {
            calls += "privacy.prepare"
            return readiness
        }

        override suspend fun allowsSharing(ownerUserId: String, pairId: String): Boolean =
            readiness == PartnerReplayReadiness.ALLOWED
    }

    private class FakeCareRepository(private val calls: MutableList<String>) : CareRepository {
        var syncCount = 0
            private set

        override fun observeCare(): Flow<List<CareItem>> = flowOf(emptyList())
        override suspend fun refresh() = Unit
        override suspend fun refreshForPush(): Set<String> = emptySet()
        override suspend fun send(kind: CareKind, message: String?) = Unit
        override suspend fun respond(requestId: String, response: CareResponse) = Unit
        override suspend fun retry(clientRequestId: String) = Unit
        override suspend fun deleteDraft(clientRequestId: String) = Unit

        override suspend fun syncPending(): Boolean {
            calls += "care.sync"
            syncCount += 1
            return true
        }

        override suspend fun clearForLogout() = Unit
    }

    private companion object {
        val USER = User(
            id = "58b78358-88f5-4b6e-a337-c729750f179f",
            email = "rafay@example.com",
            displayName = "Rafay",
        )

        fun signedIn(): SessionState = SessionState.SignedIn(USER)

        fun activePair() = PairDetails(
            id = "05ab21dd-52bb-463b-851c-683154f47c85",
            status = PairStatus.ACTIVE,
            joinCode = null,
            partner = null,
            createdAt = Instant.EPOCH,
        )
    }
}

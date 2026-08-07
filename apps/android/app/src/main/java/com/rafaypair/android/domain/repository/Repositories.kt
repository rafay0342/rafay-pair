package com.rafaypair.android.domain.repository

import com.rafaypair.android.domain.model.CareItem
import com.rafaypair.android.domain.model.CareKind
import com.rafaypair.android.domain.model.CareResponse
import com.rafaypair.android.domain.model.ConsentCapability
import com.rafaypair.android.domain.model.ConsentGrant
import com.rafaypair.android.domain.model.PairDetails
import com.rafaypair.android.domain.model.PrivacyState
import com.rafaypair.android.domain.model.RealtimeState
import com.rafaypair.android.domain.model.SessionState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

interface AuthRepository {
    val session: StateFlow<SessionState>
    suspend fun restore()
    suspend fun register(displayName: String, email: String, password: String)
    suspend fun login(email: String, password: String)
    suspend fun logout()
    suspend fun refreshAccessToken(): Boolean
}

interface PairRepository {
    val pair: StateFlow<PairDetails?>
    val loading: StateFlow<Boolean>
    suspend fun refresh()
    suspend fun create()
    suspend fun join(code: String)
    suspend fun disconnect()
    fun clear()
}

interface ConsentRepository {
    val grants: StateFlow<List<ConsentGrant>>
    suspend fun refresh()
    suspend fun update(capability: ConsentCapability, granted: Boolean)
    fun clear()
}

interface CareRepository {
    fun observeCare(): Flow<List<CareItem>>
    suspend fun refresh()
    suspend fun refreshForPush(): Set<String>
    suspend fun send(kind: CareKind, message: String?)
    suspend fun respond(requestId: String, response: CareResponse)
    suspend fun retry(clientRequestId: String)
    suspend fun deleteDraft(clientRequestId: String)
    suspend fun syncPending(): Boolean
    suspend fun clearForLogout()
}

interface PrivacyRepository {
    val state: StateFlow<PrivacyState>
    suspend fun bindCurrentScope(): Boolean
    suspend fun refresh()
    suspend fun pause()
    suspend fun resume()
    suspend fun syncPending(): Boolean
    suspend fun prepareForPartnerReplay(): PartnerReplayReadiness
    suspend fun allowsSharing(ownerUserId: String, pairId: String): Boolean
}

enum class PartnerReplayReadiness {
    ALLOWED,
    BLOCKED,
    RETRY,
}

interface RealtimeRepository {
    val state: StateFlow<RealtimeState>
    val events: Flow<String>
    fun start()
    fun stop()
}

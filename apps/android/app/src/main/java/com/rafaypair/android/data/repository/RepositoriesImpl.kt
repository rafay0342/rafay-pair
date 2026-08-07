package com.rafaypair.android.data.repository

import com.rafaypair.android.data.local.AppPreferences
import com.rafaypair.android.data.local.AccountPairScope
import com.rafaypair.android.data.local.CareDao
import com.rafaypair.android.data.local.CareDraftEntity
import com.rafaypair.android.data.local.CareSummaryEntity
import com.rafaypair.android.data.local.RotatingTokenVault
import com.rafaypair.android.data.local.SensitiveFieldCipher
import com.rafaypair.android.data.network.ApiClient
import com.rafaypair.android.data.network.ApiHttpException
import com.rafaypair.android.data.network.ApiNetworkException
import com.rafaypair.android.data.network.AuthResponseDto
import com.rafaypair.android.data.network.CareRequestDto
import com.rafaypair.android.data.network.ConsentUpdateDto
import com.rafaypair.android.data.network.CreateCareRequestDto
import com.rafaypair.android.data.network.LoginRequestDto
import com.rafaypair.android.data.network.LogoutRequestDto
import com.rafaypair.android.data.network.RegisterRequestDto
import com.rafaypair.android.data.network.RespondCareRequestDto
import com.rafaypair.android.data.network.UpdateConsentsRequestDto
import com.rafaypair.android.data.network.toDomain
import com.rafaypair.android.data.network.toDomainTokens
import com.rafaypair.android.domain.model.CareDeliveryStatus
import com.rafaypair.android.domain.model.CareDirection
import com.rafaypair.android.domain.model.CareItem
import com.rafaypair.android.domain.model.CareKind
import com.rafaypair.android.domain.model.CareResponse
import com.rafaypair.android.domain.model.ConsentCapability
import com.rafaypair.android.domain.model.ConsentGrant
import com.rafaypair.android.domain.model.PairDetails
import com.rafaypair.android.domain.model.PairStatus
import com.rafaypair.android.domain.model.Partner
import com.rafaypair.android.domain.model.PrivacyState
import com.rafaypair.android.domain.model.RepositoryFailure
import com.rafaypair.android.domain.model.SessionState
import com.rafaypair.android.domain.repository.AuthRepository
import com.rafaypair.android.domain.repository.CareRepository
import com.rafaypair.android.domain.repository.ConsentRepository
import com.rafaypair.android.domain.repository.PairRepository
import com.rafaypair.android.domain.repository.PartnerReplayReadiness
import com.rafaypair.android.domain.repository.PrivacyRepository
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class DefaultAuthRepository(
    private val api: ApiClient,
    private val tokenVault: RotatingTokenVault,
    private val refreshToken: () -> String?,
    private val preferences: AppPreferences,
    applicationScope: kotlinx.coroutines.CoroutineScope,
    private val beforeLogout: suspend () -> Unit = {},
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : AuthRepository {
    private val mutableSession = MutableStateFlow<SessionState>(SessionState.Restoring)
    private val restoreMutex = Mutex()
    override val session: StateFlow<SessionState> = mutableSession

    init {
        applicationScope.launch {
            tokenVault.hasSession.collect { hasSession ->
                if (!hasSession) {
                    preferences.clearAccountState()
                    if (mutableSession.value !is SessionState.Restoring) {
                        mutableSession.value = SessionState.SignedOut
                    }
                }
            }
        }
    }

    override suspend fun restore() = restoreMutex.withLock {
        withContext(ioDispatcher) {
            if (mutableSession.value is SessionState.SignedIn) return@withContext
            val stored = tokenVault.read()
            if (stored == null || stored.tokens.refreshTokenExpiresAt <= Instant.now()) {
                tokenVault.clear()
                preferences.clearAccountState()
                mutableSession.value = SessionState.SignedOut
                return@withContext
            }
            val valid = stored.tokens.accessTokenExpiresAt > Instant.now().plusSeconds(30) || refreshToken() != null
            val current = tokenVault.read()
            mutableSession.value = if (valid && current != null) {
                preferences.activateAccount(current.user.id)
                SessionState.SignedIn(current.user)
            } else {
                tokenVault.clear()
                preferences.clearAccountState()
                SessionState.SignedOut
            }
        }
    }

    override suspend fun register(displayName: String, email: String, password: String) {
        try {
            authenticate(api.register(RegisterRequestDto(email, password, displayName)))
        } catch (error: ApiHttpException) {
            throw error.asRepositoryFailure()
        } catch (_: ApiNetworkException) {
            throw RepositoryFailure("You’re offline", "Connect to RafayPair to create your account.")
        }
    }

    override suspend fun login(email: String, password: String) {
        try {
            authenticate(api.login(LoginRequestDto(email, password)))
        } catch (error: ApiHttpException) {
            throw error.asRepositoryFailure()
        } catch (_: ApiNetworkException) {
            throw RepositoryFailure("You’re offline", "Connect to RafayPair to sign in.")
        }
    }

    override suspend fun logout() {
        try {
            beforeLogout()
        } catch (_: Exception) {
            // Logout must still revoke the session. Any remaining registration carries
            // contentless wakes only and cannot refetch after credentials are erased.
        }
        val refresh = tokenVault.read()?.tokens?.refreshToken
        try {
            if (refresh != null) api.logout(LogoutRequestDto(refresh))
        } finally {
            tokenVault.clear()
            preferences.clearAccountState()
            mutableSession.value = SessionState.SignedOut
        }
    }

    override suspend fun refreshAccessToken(): Boolean = withContext(ioDispatcher) {
        refreshToken() != null
    }

    private suspend fun authenticate(response: AuthResponseDto) {
        val user = response.user.toDomain()
        preferences.activateAccount(user.id)
        tokenVault.save(user, response.toDomainTokens())
        mutableSession.value = SessionState.SignedIn(user)
    }
}

class DefaultPairRepository(
    private val api: ApiClient,
    private val authRepository: AuthRepository,
) : PairRepository {
    private val mutablePair = MutableStateFlow<PairDetails?>(null)
    override val pair: StateFlow<PairDetails?> = mutablePair
    private val mutableLoading = MutableStateFlow(false)
    override val loading: StateFlow<Boolean> = mutableLoading

    override suspend fun refresh() = load { api.currentPair().pair.toDomain() }

    override suspend fun create() = load { api.createPair().pair.toDomain() }

    override suspend fun join(code: String) = load { api.joinPair(code).pair.toDomain() }

    override suspend fun disconnect() {
        mutableLoading.value = true
        try {
            api.disconnectPair()
            mutablePair.value = null
        } catch (error: ApiHttpException) {
            if (error.status == 404) mutablePair.value = null else throw error.asRepositoryFailure()
        } finally {
            mutableLoading.value = false
        }
    }

    override fun clear() {
        mutablePair.value = null
    }

    private suspend fun load(block: suspend () -> PairDetails) {
        mutableLoading.value = true
        try {
            mutablePair.value = block()
        } catch (error: ApiHttpException) {
            if (error.status == 404) mutablePair.value = null else throw error.asRepositoryFailure()
        } catch (error: ApiNetworkException) {
            throw RepositoryFailure("You’re offline", error.message ?: "Check your connection and try again.")
        } finally {
            mutableLoading.value = false
        }
    }

    private fun com.rafaypair.android.data.network.PairDto.toDomain(): PairDetails {
        val currentUserId = (authRepository.session.value as? SessionState.SignedIn)?.user?.id
        val partner = members.firstOrNull { it.userId != currentUserId }?.let {
            Partner(id = it.userId, displayName = it.displayName)
        }
        return PairDetails(
            id = id,
            status = if (status == "active") PairStatus.ACTIVE else PairStatus.WAITING_FOR_PARTNER,
            joinCode = joinCode,
            partner = partner,
            createdAt = Instant.parse(createdAt),
        )
    }
}

class DefaultConsentRepository(private val api: ApiClient) : ConsentRepository {
    private val mutableGrants = MutableStateFlow(defaultGrants())
    override val grants: StateFlow<List<ConsentGrant>> = mutableGrants

    override suspend fun refresh() {
        try {
            mutableGrants.value = api.consents().grants.map { grant ->
                ConsentGrant(
                    capability = ConsentCapability.valueOf(grant.capability.uppercase()),
                    granted = grant.granted,
                    updatedAt = Instant.parse(grant.updatedAt),
                )
            }.sortedBy { it.capability.ordinal }
        } catch (error: ApiHttpException) {
            if (error.status == 404) clear() else throw error.asRepositoryFailure()
        } catch (error: ApiNetworkException) {
            throw RepositoryFailure("You’re offline", error.message ?: "Consent could not be refreshed.")
        }
    }

    override suspend fun update(capability: ConsentCapability, granted: Boolean) {
        try {
            val response = api.updateConsents(
                UpdateConsentsRequestDto(listOf(ConsentUpdateDto(capability.name.lowercase(), granted))),
            )
            mutableGrants.value = response.grants.map { grant ->
                ConsentGrant(
                    ConsentCapability.valueOf(grant.capability.uppercase()),
                    grant.granted,
                    Instant.parse(grant.updatedAt),
                )
            }.sortedBy { it.capability.ordinal }
        } catch (error: ApiHttpException) {
            throw error.asRepositoryFailure()
        } catch (error: ApiNetworkException) {
            throw RepositoryFailure(
                "Change not applied",
                "Consent changes require a connection. Your previous setting remains active.",
            )
        }
    }

    override fun clear() {
        mutableGrants.value = defaultGrants()
    }

    private companion object {
        fun defaultGrants() = ConsentCapability.entries.map { ConsentGrant(it, false, null) }
    }
}

class DefaultCareRepository(
    private val api: ApiClient,
    private val dao: CareDao,
    private val cipher: SensitiveFieldCipher,
    private val authRepository: AuthRepository,
    private val pairRepository: PairRepository,
    private val consentRepository: ConsentRepository,
    private val privacyRepository: PrivacyRepository,
) : CareRepository {
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    override fun observeCare(): Flow<List<CareItem>> = authRepository.session
        .map { (it as? SessionState.SignedIn)?.user?.id }
        .distinctUntilChanged()
        .flatMapLatest { ownerId ->
            if (ownerId == null) return@flatMapLatest flowOf(emptyList())
            combine(dao.observeDrafts(ownerId), dao.observeSummaries(ownerId)) { drafts, summaries ->
                (drafts.map { it.toDomain() } + summaries.map { it.toDomain() })
                    .sortedByDescending(CareItem::createdAt)
            }
        }

    override suspend fun refresh() {
        val ownerId = currentUserId()
        try {
            refreshFromServer(ownerId)
        } catch (error: ApiHttpException) {
            if (error.status != 404) throw error.asRepositoryFailure()
        } catch (_: ApiNetworkException) {
            // The encrypted Room timeline remains useful offline.
        }
    }

    override suspend fun refreshForPush(): Set<String> {
        val ownerId = currentUserId()
        val remoteItems = refreshFromServer(ownerId)
        return remoteItems
            .asSequence()
            .filter { it.recipientUserId == ownerId && it.status == "pending" }
            .sortedByDescending { Instant.parse(it.createdAt) }
            .map(CareRequestDto::id)
            .toCollection(LinkedHashSet())
    }

    override suspend fun send(kind: CareKind, message: String?) {
        val ownerId = currentUserId()
        val pairId = pairRepository.pair.value?.id
            ?: throw RepositoryFailure("Pair required", "Connect with your partner before sending care.")
        requirePrivacySharing(ownerId, pairId)
        val clientId = UUID.randomUUID().toString()
        val now = System.currentTimeMillis()
        val draft = CareDraftEntity(
            clientRequestId = clientId,
            ownerUserId = ownerId,
            pairId = pairId,
            kind = kind.name,
            encryptedMessage = cipher.encrypt(message),
            state = CareDeliveryStatus.QUEUED.name,
            lastError = null,
            createdAtEpochMillis = now,
            updatedAtEpochMillis = now,
        )
        dao.upsertDraft(draft)
        deliver(draft, throwOnPermanentFailure = true)
    }

    override suspend fun respond(requestId: String, response: CareResponse) {
        val ownerId = currentUserId()
        val pairId = pairRepository.pair.value?.takeIf { it.status == PairStatus.ACTIVE }?.id
            ?: throw RepositoryFailure("Pair required", "Connect with your partner before responding to care.")
        requirePrivacySharing(ownerId, pairId)
        try {
            val updated = api.respondCare(requestId, RespondCareRequestDto(response.name.lowercase())).careRequest
            dao.upsertSummaries(listOf(updated.toEntity(ownerId)))
        } catch (error: ApiHttpException) {
            throw error.asRepositoryFailure()
        } catch (error: ApiNetworkException) {
            throw RepositoryFailure("Response not sent", "Reconnect, then respond to this request.")
        }
    }

    override suspend fun retry(clientRequestId: String) {
        val ownerId = currentUserId()
        val draft = dao.draftForOwner(clientRequestId, ownerId) ?: return
        deliver(draft.copy(state = CareDeliveryStatus.QUEUED.name), throwOnPermanentFailure = true)
    }

    override suspend fun deleteDraft(clientRequestId: String) {
        dao.deleteDraftForOwner(clientRequestId, currentUserId())
    }

    override suspend fun syncPending(): Boolean {
        val ownerId = runCatching { currentUserId() }.getOrNull() ?: return true
        return try {
            pairRepository.refresh()
            consentRepository.refresh()
            val pair = pairRepository.pair.value?.takeIf { it.status == PairStatus.ACTIVE } ?: return true
            if (!privacyRepository.allowsSharing(ownerId, pair.id)) return true
            dao.pendingDrafts(ownerId).all { deliver(it, throwOnPermanentFailure = false) }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            false
        }
    }

    override suspend fun clearForLogout() {
        val ownerId = (authRepository.session.value as? SessionState.SignedIn)?.user?.id ?: return
        dao.deleteDraftsForOwner(ownerId)
        dao.deleteSummariesForOwner(ownerId)
    }

    private suspend fun refreshFromServer(ownerId: String): List<CareRequestDto> {
        val remoteItems = api.careRequests().items
        dao.upsertSummaries(remoteItems.map { it.toEntity(ownerId) })
        return remoteItems
    }

    private suspend fun deliver(draft: CareDraftEntity, throwOnPermanentFailure: Boolean): Boolean {
        val currentOwnerId = runCatching { currentUserId() }.getOrNull()
        val currentPair = pairRepository.pair.value
        if (
            !CareDraftDeliveryPolicy.canDeliver(
                draftOwnerId = draft.ownerUserId,
                draftPairId = draft.pairId,
                currentOwnerId = currentOwnerId,
                currentPair = currentPair,
            )
        ) {
            dao.upsertDraft(
                draft.copy(
                    state = CareDeliveryStatus.BLOCKED.name,
                    lastError = "This request belongs to a partner connection that is no longer active.",
                    updatedAtEpochMillis = System.currentTimeMillis(),
                ),
            )
            if (throwOnPermanentFailure) {
                throw RepositoryFailure(
                    "Request not sent",
                    "This queued request belongs to a previous partner connection. Delete it instead of sending it to someone else.",
                )
            }
            return true
        }
        if (!privacyRepository.allowsSharing(draft.ownerUserId, draft.pairId)) {
            if (throwOnPermanentFailure) {
                throw RepositoryFailure(
                    "Privacy sharing is paused",
                    "Confirm privacy sharing with the server before sending this request.",
                    code = "PRIVACY_NOT_CONFIRMED",
                )
            }
            return true
        }
        dao.upsertDraft(draft.copy(state = "QUEUED", lastError = null, updatedAtEpochMillis = System.currentTimeMillis()))
        return try {
            val created = api.sendCare(
                CreateCareRequestDto(
                    clientRequestId = draft.clientRequestId,
                    kind = CareKind.valueOf(draft.kind).name.lowercase(),
                    message = cipher.decrypt(draft.encryptedMessage),
                ),
            ).careRequest
            dao.upsertSummaries(listOf(created.toEntity(draft.ownerUserId)))
            dao.deleteDraftForOwner(draft.clientRequestId, draft.ownerUserId)
            true
        } catch (_: ApiNetworkException) {
            false
        } catch (error: ApiHttpException) {
            if (error.problem.code == "PRIVACY_PAUSED") return false
            dao.upsertDraft(
                draft.copy(
                    state = CareDeliveryStatus.FAILED.name,
                    lastError = error.problem.detail ?: error.problem.title,
                    updatedAtEpochMillis = System.currentTimeMillis(),
                ),
            )
            if (throwOnPermanentFailure) throw error.asRepositoryFailure()
            true
        }
    }

    private suspend fun requirePrivacySharing(ownerId: String, pairId: String) {
        if (!privacyRepository.allowsSharing(ownerId, pairId)) {
            throw RepositoryFailure(
                "Privacy sharing is paused",
                "Confirm privacy sharing with the server before sending partner-visible data.",
                code = "PRIVACY_NOT_CONFIRMED",
            )
        }
    }

    private fun CareRequestDto.toEntity(ownerId: String): CareSummaryEntity {
        val otherName = pairRepository.pair.value?.partner?.displayName
        return CareSummaryEntity(
            requestId = id,
            ownerUserId = ownerId,
            clientRequestId = clientRequestId,
            kind = kind.uppercase(),
            encryptedMessage = cipher.encrypt(message),
            direction = if (senderUserId == ownerId) CareDirection.SENT.name else CareDirection.RECEIVED.name,
            status = status.uppercase(),
            encryptedOtherDisplayName = cipher.encrypt(otherName),
            createdAtEpochMillis = Instant.parse(createdAt).toEpochMilli(),
            respondedAtEpochMillis = respondedAt?.let(Instant::parse)?.toEpochMilli(),
        )
    }

    private fun CareDraftEntity.toDomain() = CareItem(
        id = "local:$clientRequestId",
        clientRequestId = clientRequestId,
        kind = CareKind.valueOf(kind),
        message = cipher.decrypt(encryptedMessage),
        direction = CareDirection.SENT,
        status = CareDeliveryStatus.valueOf(state),
        otherDisplayName = pairRepository.pair.value
            ?.takeIf { it.id == pairId }
            ?.partner
            ?.displayName,
        createdAt = Instant.ofEpochMilli(createdAtEpochMillis),
        respondedAt = null,
    )

    private fun CareSummaryEntity.toDomain() = CareItem(
        id = requestId,
        clientRequestId = clientRequestId,
        kind = CareKind.valueOf(kind),
        message = cipher.decrypt(encryptedMessage),
        direction = CareDirection.valueOf(direction),
        status = when (status) {
            "PENDING" -> CareDeliveryStatus.SENT
            "EXPIRED" -> CareDeliveryStatus.DECLINED
            else -> CareDeliveryStatus.valueOf(status)
        },
        otherDisplayName = cipher.decrypt(encryptedOtherDisplayName),
        createdAt = Instant.ofEpochMilli(createdAtEpochMillis),
        respondedAt = respondedAtEpochMillis?.let(Instant::ofEpochMilli),
    )

    private fun currentUserId(): String =
        (authRepository.session.value as? SessionState.SignedIn)?.user?.id
            ?: throw RepositoryFailure("Sign in required", "Sign in to continue.")
}

internal object CareDraftDeliveryPolicy {
    fun canDeliver(
        draftOwnerId: String,
        draftPairId: String,
        currentOwnerId: String?,
        currentPair: PairDetails?,
    ): Boolean =
        currentOwnerId == draftOwnerId &&
            currentPair?.status == PairStatus.ACTIVE &&
            currentPair.id == draftPairId
}

class DefaultPrivacyRepository(
    private val api: ApiClient,
    private val preferences: AppPreferences,
    applicationScope: kotlinx.coroutines.CoroutineScope,
    private val authRepository: AuthRepository,
    private val pairRepository: PairRepository,
) : PrivacyRepository {
    private val operationMutex = Mutex()
    override val state: StateFlow<PrivacyState> = preferences.privacy.stateIn(
        applicationScope,
        SharingStarted.Eagerly,
        PrivacyState(),
    )

    override suspend fun bindCurrentScope(): Boolean = operationMutex.withLock { bindCurrentScopeLocked() != null }

    override suspend fun refresh() = operationMutex.withLock {
        val scope = bindCurrentScopeLocked() ?: return@withLock
        val current = preferences.privacyState(scope)
        if (current.syncPending) return@withLock
        try {
            confirmResponse(scope, api.privacy().privacy, expectedPaused = null)
        } catch (error: ApiHttpException) {
            if (error.status == 409 || error.status == 404) {
                preferences.invalidatePairScope(scope)
            } else {
                throw error.asRepositoryFailure()
            }
        } catch (_: ApiNetworkException) {
            // The scope remains fail-closed unless a prior response confirmed this exact pair.
        }
    }

    override suspend fun pause() = operationMutex.withLock {
        val scope = bindCurrentScopeLocked()
            ?: throw RepositoryFailure("Pair required", "Connect with your partner before changing privacy.")
        check(preferences.requestPrivacy(scope, true)) { "Privacy scope changed while pausing" }
        syncOrThrow(scope, true)
    }

    override suspend fun resume() = operationMutex.withLock {
        val scope = bindCurrentScopeLocked()
            ?: throw RepositoryFailure("Pair required", "Connect with your partner before changing privacy.")
        val current = preferences.privacyState(scope)
        if (current.syncPending && current.desiredPaused) {
            throw RepositoryFailure(
                "Sharing remains paused",
                "Finish confirming the privacy pause before resuming sharing.",
            )
        }
        check(preferences.requestPrivacy(scope, false)) { "Privacy scope changed while resuming" }
        syncOrThrow(scope, false)
    }

    override suspend fun syncPending(): Boolean = operationMutex.withLock {
        val scope = bindCurrentScopeLocked() ?: return@withLock true
        val current = preferences.privacyState(scope)
        if (!current.syncPending) return@withLock true
        return@withLock try {
            confirmResponse(
                scope,
                api.setPrivacyPaused(current.desiredPaused).privacy,
                expectedPaused = current.desiredPaused,
            )
            true
        } catch (error: CancellationException) {
            throw error
        } catch (error: ApiHttpException) {
            if (error.status == 404 || error.status == 409) preferences.invalidatePairScope(scope)
            false
        } catch (_: ApiNetworkException) {
            false
        } catch (_: InvalidPrivacyScopeResponse) {
            false
        }
    }

    override suspend fun prepareForPartnerReplay(): PartnerReplayReadiness = operationMutex.withLock {
        val scope = bindCurrentScopeLocked() ?: return@withLock PartnerReplayReadiness.BLOCKED
        val current = preferences.privacyState(scope)
        try {
            val confirmed = if (current.syncPending) {
                api.setPrivacyPaused(current.desiredPaused).privacy
            } else {
                api.privacy().privacy
            }
            confirmResponse(
                scope,
                confirmed,
                expectedPaused = current.desiredPaused.takeIf { current.syncPending },
            )
            val refreshed = preferences.privacyState(scope)
            if (refreshed.allowsSharing(scope.ownerUserId, scope.pairId)) {
                PartnerReplayReadiness.ALLOWED
            } else {
                PartnerReplayReadiness.BLOCKED
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: ApiNetworkException) {
            PartnerReplayReadiness.RETRY
        } catch (error: ApiHttpException) {
            if (error.status == 404 || error.status == 409) {
                preferences.invalidatePairScope(scope)
                PartnerReplayReadiness.BLOCKED
            } else {
                PartnerReplayReadiness.RETRY
            }
        } catch (_: InvalidPrivacyScopeResponse) {
            PartnerReplayReadiness.RETRY
        }
    }

    override suspend fun allowsSharing(ownerUserId: String, pairId: String): Boolean =
        preferences.privacyState(AccountPairScope(ownerUserId, pairId)).allowsSharing(ownerUserId, pairId)

    private suspend fun syncOrThrow(scope: AccountPairScope, paused: Boolean) {
        try {
            confirmResponse(scope, api.setPrivacyPaused(paused).privacy, expectedPaused = paused)
        } catch (_: ApiNetworkException) {
            if (!paused) {
                throw RepositoryFailure(
                    "Sharing remains paused",
                    "Resume needs a connection so the server can confirm the privacy change.",
                )
            }
        } catch (error: ApiHttpException) {
            if (error.status == 404 || error.status == 409) preferences.invalidatePairScope(scope)
            if (!paused) throw error.asRepositoryFailure()
            // A local pause remains effective even while server synchronization retries.
        }
    }

    private suspend fun bindCurrentScopeLocked(): AccountPairScope? {
        val ownerId = (authRepository.session.value as? SessionState.SignedIn)?.user?.id
        if (ownerId == null) {
            preferences.clearAccountState()
            return null
        }
        preferences.activateAccount(ownerId)
        val activePair = pairRepository.pair.value?.takeIf { it.status == PairStatus.ACTIVE }
        if (activePair == null) {
            preferences.clearPairScope(ownerId)
            return null
        }
        val scope = AccountPairScope(ownerId, activePair.id)
        return scope.takeIf { preferences.bindPairScope(it) }
    }

    private suspend fun confirmResponse(
        scope: AccountPairScope,
        response: com.rafaypair.android.data.network.PrivacyDto,
        expectedPaused: Boolean?,
    ) {
        if (
            response.userId != scope.ownerUserId ||
            response.pairId != scope.pairId ||
            (expectedPaused != null && response.paused != expectedPaused)
        ) {
            preferences.invalidatePairScope(scope)
            throw InvalidPrivacyScopeResponse()
        }
        if (!preferences.confirmPrivacy(scope, response.paused)) {
            preferences.invalidatePairScope(scope)
            throw InvalidPrivacyScopeResponse()
        }
    }
}

private class InvalidPrivacyScopeResponse : Exception()

private fun ApiHttpException.asRepositoryFailure() = RepositoryFailure(
    title = problem.title,
    message = problem.detail ?: problem.title,
    status = status,
    code = problem.code,
)

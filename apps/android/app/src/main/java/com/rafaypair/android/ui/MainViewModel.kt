package com.rafaypair.android.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.rafaypair.android.domain.model.CareItem
import com.rafaypair.android.domain.model.CareKind
import com.rafaypair.android.domain.model.CareResponse
import com.rafaypair.android.domain.model.ConsentCapability
import com.rafaypair.android.domain.model.ConsentGrant
import com.rafaypair.android.domain.model.PairDetails
import com.rafaypair.android.domain.model.PairStatus
import com.rafaypair.android.domain.model.PrivacyState
import com.rafaypair.android.domain.model.RealtimeState
import com.rafaypair.android.domain.model.RepositoryFailure
import com.rafaypair.android.domain.model.SessionState
import com.rafaypair.android.domain.repository.AuthRepository
import com.rafaypair.android.domain.repository.CareRepository
import com.rafaypair.android.domain.repository.ConsentRepository
import com.rafaypair.android.domain.repository.PairRepository
import com.rafaypair.android.domain.repository.PrivacyRepository
import com.rafaypair.android.domain.repository.RealtimeRepository
import com.rafaypair.android.domain.usecase.CareUseCases
import com.rafaypair.android.domain.usecase.ConsentUseCases
import com.rafaypair.android.domain.usecase.LoginUseCase
import com.rafaypair.android.domain.usecase.PairUseCases
import com.rafaypair.android.domain.usecase.PrivacyUseCases
import com.rafaypair.android.domain.usecase.RegisterUseCase
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

enum class AuthMode { LOGIN, REGISTER }
enum class AppTab { HOME, MOVE, TOGETHER, VITALS, CARE, CONSENT, ACCOUNT }

data class AuthForm(
    val mode: AuthMode = AuthMode.LOGIN,
    val displayName: String = "",
    val email: String = "",
    val password: String = "",
    val showPassword: Boolean = false,
)

data class CareComposer(
    val kind: CareKind = CareKind.CHECK_IN,
    val message: String = "",
)

data class MainUiState(
    val session: SessionState = SessionState.Restoring,
    val pair: PairDetails? = null,
    val pairLoading: Boolean = false,
    val grants: List<ConsentGrant> = emptyList(),
    val care: List<CareItem> = emptyList(),
    val privacy: PrivacyState = PrivacyState(),
    val realtime: RealtimeState = RealtimeState.STOPPED,
    val selectedTab: AppTab = AppTab.HOME,
    val authForm: AuthForm = AuthForm(),
    val joinCode: String = "",
    val composer: CareComposer = CareComposer(),
    val busyActions: Set<String> = emptySet(),
    val pendingConsent: ConsentCapability? = null,
) {
    val partnerSharingAllowed: Boolean
        get() {
            val ownerId = (session as? SessionState.SignedIn)?.user?.id ?: return false
            val pairId = pair?.takeIf { it.status == PairStatus.ACTIVE }?.id ?: return false
            return privacy.allowsSharing(ownerId, pairId)
        }
}

sealed interface UiEvent {
    data class Notice(val message: String) : UiEvent
    data class Error(val title: String, val message: String) : UiEvent
}

class MainViewModel(
    private val register: RegisterUseCase,
    private val login: LoginUseCase,
    private val authRepository: AuthRepository,
    private val pair: PairUseCases,
    private val pairRepository: PairRepository,
    private val consent: ConsentUseCases,
    private val consentRepository: ConsentRepository,
    private val care: CareUseCases,
    private val careRepository: CareRepository,
    private val privacy: PrivacyUseCases,
    private val privacyRepository: PrivacyRepository,
    private val realtimeRepository: RealtimeRepository,
    private val scheduleCareSync: () -> Unit,
    private val schedulePrivacySync: () -> Unit,
    private val enablePushNotifications: () -> Boolean,
) : ViewModel() {
    private val selectedTab = MutableStateFlow(AppTab.HOME)
    private val authForm = MutableStateFlow(AuthForm())
    private val joinCode = MutableStateFlow("")
    private val composer = MutableStateFlow(CareComposer())
    private val busyActions = MutableStateFlow<Set<String>>(emptySet())
    private val pendingConsent = MutableStateFlow<ConsentCapability?>(null)
    private val mutableEvents = MutableSharedFlow<UiEvent>(extraBufferCapacity = 8)
    val events: Flow<UiEvent> = mutableEvents

    private data class RemoteState(
        val session: SessionState,
        val pair: PairDetails?,
        val pairLoading: Boolean,
        val grants: List<ConsentGrant>,
    )

    private data class ActivityState(
        val care: List<CareItem>,
        val privacy: PrivacyState,
        val realtime: RealtimeState,
    )

    private data class FormState(
        val selectedTab: AppTab,
        val authForm: AuthForm,
        val joinCode: String,
        val composer: CareComposer,
    )

    private data class ActionState(
        val busyActions: Set<String>,
        val pendingConsent: ConsentCapability?,
    )

    private val remoteState = combine(
        authRepository.session,
        pairRepository.pair,
        pairRepository.loading,
        consentRepository.grants,
    ) { session, pair, loading, grants -> RemoteState(session, pair, loading, grants) }

    private val activityState = combine(
        careRepository.observeCare(),
        privacyRepository.state,
        realtimeRepository.state,
    ) { items, privacyState, realtime -> ActivityState(items, privacyState, realtime) }

    private val formState = combine(selectedTab, authForm, joinCode, composer) { tab, auth, code, careComposer ->
        FormState(tab, auth, code, careComposer)
    }

    private val actionState = combine(busyActions, pendingConsent) { busy, pending ->
        ActionState(busy, pending)
    }

    val uiState: StateFlow<MainUiState> = combine(
        remoteState,
        activityState,
        formState,
        actionState,
    ) { remote, activity, form, action ->
        MainUiState(
            session = remote.session,
            pair = remote.pair,
            pairLoading = remote.pairLoading,
            grants = remote.grants,
            care = activity.care,
            privacy = activity.privacy,
            realtime = activity.realtime,
            selectedTab = form.selectedTab,
            authForm = form.authForm,
            joinCode = form.joinCode,
            composer = form.composer,
            busyActions = action.busyActions,
            pendingConsent = action.pendingConsent,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), MainUiState())

    init {
        viewModelScope.launch {
            authRepository.restore()
            if (authRepository.session.value is SessionState.SignedIn) refreshAll(showError = false)
        }
    }

    fun selectTab(tab: AppTab) {
        selectedTab.value = tab
    }

    fun setAuthMode(mode: AuthMode) {
        authForm.value = authForm.value.copy(mode = mode, password = "")
    }

    fun setDisplayName(value: String) {
        authForm.value = authForm.value.copy(displayName = value.take(80))
    }

    fun setEmail(value: String) {
        authForm.value = authForm.value.copy(email = value.take(254))
    }

    fun setPassword(value: String) {
        authForm.value = authForm.value.copy(password = value.take(128))
    }

    fun togglePasswordVisibility() {
        authForm.value = authForm.value.copy(showPassword = !authForm.value.showPassword)
    }

    fun submitAuth() {
        val form = authForm.value
        val validation = validateAuth(form)
        if (validation != null) {
            mutableEvents.tryEmit(UiEvent.Error("Check your details", validation))
            return
        }
        launchAction(ACTION_AUTH) {
            if (form.mode == AuthMode.REGISTER) {
                register(form.displayName, form.email, form.password)
            } else {
                login(form.email, form.password)
            }
            authForm.value = AuthForm(mode = form.mode, email = form.email)
            refreshAll(showError = false)
        }
    }

    fun refresh() {
        launchAction(ACTION_REFRESH) { refreshAll(showError = true) }
    }

    fun createPair() {
        launchAction(ACTION_PAIR) {
            pair.create()
            privacyRepository.bindCurrentScope()
            mutableEvents.emit(UiEvent.Notice("Invite created. Share the code directly with your partner."))
        }
    }

    fun setJoinCode(value: String) {
        joinCode.value = value.uppercase().filter { it.isLetterOrDigit() }.take(8)
    }

    fun joinPair() {
        val code = joinCode.value
        if (!code.matches(Regex("^[A-Z2-9]{8}$"))) {
            mutableEvents.tryEmit(UiEvent.Error("Invalid invite code", "Enter the 8-character code from your partner."))
            return
        }
        launchAction(ACTION_PAIR) {
            pair.join(code)
            joinCode.value = ""
            privacyRepository.refresh()
            consent.refresh()
            care.refresh()
            mutableEvents.emit(UiEvent.Notice("You and your partner are now connected."))
        }
    }

    fun disconnectPair() {
        launchAction(ACTION_PAIR) {
            realtimeRepository.stop()
            pair.disconnect()
            privacyRepository.bindCurrentScope()
            consentRepository.clear()
            mutableEvents.emit(UiEvent.Notice("Pair disconnected. Partner sharing has stopped."))
        }
    }

    fun updateConsent(capability: ConsentCapability, granted: Boolean) {
        if (pendingConsent.value != null) return
        pendingConsent.value = capability
        viewModelScope.launch {
            try {
                consent.update(capability, granted)
                mutableEvents.emit(
                    UiEvent.Notice(if (granted) "${capability.title} enabled." else "${capability.title} stopped."),
                )
            } catch (error: Throwable) {
                emitError(error)
            } finally {
                pendingConsent.value = null
            }
        }
    }

    fun selectCareKind(kind: CareKind) {
        composer.value = composer.value.copy(kind = kind)
    }

    fun setCareMessage(value: String) {
        composer.value = composer.value.copy(message = value.take(500))
    }

    fun sendCare() {
        val draft = composer.value
        launchAction(ACTION_CARE) {
            requireSharingAllowed()
            care.send(draft.kind, draft.message)
            composer.value = CareComposer()
            scheduleCareSync()
            mutableEvents.emit(UiEvent.Notice("Care request saved and queued safely if you’re offline."))
        }
    }

    fun respondCare(requestId: String, response: CareResponse) {
        launchAction("respond:$requestId") {
            requireSharingAllowed()
            care.respond(requestId, response)
            mutableEvents.emit(UiEvent.Notice("Response sent."))
        }
    }

    fun retryCare(clientRequestId: String) {
        launchAction("retry:$clientRequestId") {
            requireSharingAllowed()
            care.retry(clientRequestId)
            scheduleCareSync()
            mutableEvents.emit(UiEvent.Notice("Care request queued for delivery."))
        }
    }

    fun deleteDraft(clientRequestId: String) {
        launchAction("delete:$clientRequestId") { care.deleteDraft(clientRequestId) }
    }

    fun setPrivacyPaused(paused: Boolean) {
        launchAction(ACTION_PRIVACY) {
            try {
                if (paused) {
                    realtimeRepository.stop()
                    privacy.pause()
                    mutableEvents.emit(UiEvent.Notice("Privacy pause is active on this phone."))
                } else {
                    privacy.resume()
                    mutableEvents.emit(UiEvent.Notice("Sharing resumed after server confirmation."))
                }
            } finally {
                schedulePrivacySync()
            }
        }
    }

    fun logout() {
        launchAction(ACTION_LOGOUT) {
            realtimeRepository.stop()
            careRepository.clearForLogout()
            authRepository.logout()
            pairRepository.clear()
            consentRepository.clear()
            selectedTab.value = AppTab.HOME
        }
    }

    fun enableNotifications() {
        launchAction(ACTION_NOTIFICATIONS) {
            if (enablePushNotifications()) {
                mutableEvents.emit(UiEvent.Notice("Care notifications are enabled for this device."))
            } else {
                mutableEvents.emit(
                    UiEvent.Error(
                        "Notifications unavailable",
                        "This development build has no Firebase project configuration.",
                    ),
                )
            }
        }
    }

    private suspend fun refreshAll(showError: Boolean) {
        val results = mutableListOf(runCatching { pair.refresh() })
        results += runCatching {
            privacyRepository.bindCurrentScope()
            privacy.refresh()
        }
        results += listOf(
            viewModelScope.async { runCatching { consent.refresh() } },
            viewModelScope.async { runCatching { care.refresh() } },
        ).awaitAll()
        if (showError) results.firstNotNullOfOrNull { it.exceptionOrNull() }?.let { emitError(it) }
        schedulePrivacySync()
        scheduleCareSync()
    }

    private suspend fun requireSharingAllowed() {
        val ownerId = (authRepository.session.value as? SessionState.SignedIn)?.user?.id
        val pairId = pairRepository.pair.value?.takeIf { it.status == PairStatus.ACTIVE }?.id
        if (ownerId == null || pairId == null || !privacyRepository.allowsSharing(ownerId, pairId)) {
            throw RepositoryFailure(
                "Privacy sharing is paused",
                "Wait for the server to confirm privacy sharing before sending partner-visible data.",
                code = "PRIVACY_NOT_CONFIRMED",
            )
        }
    }

    private fun launchAction(key: String, block: suspend () -> Unit) {
        if (key in busyActions.value) return
        busyActions.value += key
        viewModelScope.launch {
            try {
                block()
            } catch (error: Throwable) {
                emitError(error)
            } finally {
                busyActions.value -= key
            }
        }
    }

    private suspend fun emitError(error: Throwable) {
        val failure = error as? RepositoryFailure
        mutableEvents.emit(
            UiEvent.Error(
                title = failure?.title ?: "Something went wrong",
                message = failure?.message ?: "Please try again.",
            ),
        )
    }

    private fun validateAuth(form: AuthForm): String? {
        if (form.mode == AuthMode.REGISTER && form.displayName.trim().isEmpty()) return "Enter your name."
        if (!android.util.Patterns.EMAIL_ADDRESS.matcher(form.email.trim()).matches()) return "Enter a valid email address."
        if (form.mode == AuthMode.REGISTER) {
            if (form.password.length < 12) return "Use at least 12 characters for your password."
            if (!form.password.any(Char::isLetter) || !form.password.any(Char::isDigit)) {
                return "Your password needs at least one letter and one number."
            }
        } else if (form.password.isEmpty()) return "Enter your password."
        return null
    }

    class Factory(
        private val register: RegisterUseCase,
        private val login: LoginUseCase,
        private val authRepository: AuthRepository,
        private val pair: PairUseCases,
        private val pairRepository: PairRepository,
        private val consent: ConsentUseCases,
        private val consentRepository: ConsentRepository,
        private val care: CareUseCases,
        private val careRepository: CareRepository,
        private val privacy: PrivacyUseCases,
        private val privacyRepository: PrivacyRepository,
        private val realtimeRepository: RealtimeRepository,
        private val scheduleCareSync: () -> Unit,
        private val schedulePrivacySync: () -> Unit,
        private val enablePushNotifications: () -> Boolean,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            require(modelClass.isAssignableFrom(MainViewModel::class.java))
            return MainViewModel(
                register,
                login,
                authRepository,
                pair,
                pairRepository,
                consent,
                consentRepository,
                care,
                careRepository,
                privacy,
                privacyRepository,
                realtimeRepository,
                scheduleCareSync,
                schedulePrivacySync,
                enablePushNotifications,
            ) as T
        }
    }

    private companion object {
        const val ACTION_AUTH = "auth"
        const val ACTION_REFRESH = "refresh"
        const val ACTION_PAIR = "pair"
        const val ACTION_CARE = "care"
        const val ACTION_PRIVACY = "privacy"
        const val ACTION_LOGOUT = "logout"
        const val ACTION_NOTIFICATIONS = "notifications"
    }
}

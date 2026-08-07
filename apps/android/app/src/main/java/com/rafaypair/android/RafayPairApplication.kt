package com.rafaypair.android

import android.app.Application
import androidx.room.Room
import com.rafaypair.android.data.local.AppPreferences
import com.rafaypair.android.data.local.RafayPairDatabase
import com.rafaypair.android.data.local.RotatingTokenVault
import com.rafaypair.android.data.local.SensitiveFieldCipher
import com.rafaypair.android.data.local.PushRegistrationStore
import com.rafaypair.android.data.network.ApiClient
import com.rafaypair.android.data.network.DefaultRealtimeRepository
import com.rafaypair.android.data.network.RefreshCoordinator
import com.rafaypair.android.data.network.VoiceClient
import com.rafaypair.android.data.repository.DefaultAssistantRepository
import com.rafaypair.android.data.repository.DefaultAuthRepository
import com.rafaypair.android.data.repository.DefaultCareRepository
import com.rafaypair.android.data.repository.DefaultConsentRepository
import com.rafaypair.android.data.repository.DefaultPairRepository
import com.rafaypair.android.data.repository.DefaultPrivacyRepository
import com.rafaypair.android.data.repository.DefaultTogetherRepository
import com.rafaypair.android.data.repository.NotificationDeviceRepository
import com.rafaypair.android.data.repository.ReconnectSyncCoordinator
import com.rafaypair.android.data.repository.SyncScheduler
import com.rafaypair.android.domain.model.PairStatus
import com.rafaypair.android.domain.model.SessionState
import com.rafaypair.android.domain.repository.AssistantRepository
import com.rafaypair.android.domain.repository.AuthRepository
import com.rafaypair.android.domain.repository.CareRepository
import com.rafaypair.android.domain.repository.ConsentRepository
import com.rafaypair.android.domain.repository.PairRepository
import com.rafaypair.android.domain.repository.PrivacyRepository
import com.rafaypair.android.domain.repository.RealtimeRepository
import com.rafaypair.android.domain.repository.TogetherRepository
import com.rafaypair.android.domain.usecase.CareUseCases
import com.rafaypair.android.domain.usecase.ConsentUseCases
import com.rafaypair.android.domain.usecase.LoginUseCase
import com.rafaypair.android.domain.usecase.PairUseCases
import com.rafaypair.android.domain.usecase.PrivacyUseCases
import com.rafaypair.android.domain.usecase.RegisterUseCase
import com.rafaypair.android.ui.MainViewModel
import com.rafaypair.android.notifications.FirebaseBootstrap
import com.rafaypair.android.notifications.PushCoordinator
import com.rafaypair.android.integrity.PlayIntegrityCoordinator
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient

class RafayPairApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        val firebaseAvailable = FirebaseBootstrap.initialize(this)
        container = AppContainer(this, firebaseAvailable)
        SyncScheduler.enqueueCare(this)
        SyncScheduler.enqueuePrivacy(this)
    }
}

/**
 * Explicit application-scoped dependency graph. A single Android module has no dynamic feature
 * graph, so constructor wiring is smaller and easier to audit than generated DI while retaining
 * strict ViewModel -> use case -> repository boundaries.
 */
class AppContainer(application: Application, firebaseAvailable: Boolean) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
    }
    private val preferences = AppPreferences(application)
    private val tokenVault = RotatingTokenVault(application, json)
    val pushRegistrationStore = PushRegistrationStore(application, json)
    private val rawHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()
    private val refreshCoordinator = RefreshCoordinator(
        BuildConfig.API_BASE_URL,
        json,
        tokenVault,
        rawHttpClient,
    )
    val api = ApiClient(BuildConfig.API_BASE_URL, json, tokenVault, refreshCoordinator)
    val notificationDeviceRepository = NotificationDeviceRepository(api, pushRegistrationStore, preferences)
    val playIntegrityCoordinator = PlayIntegrityCoordinator(
        application = application,
        api = api,
        applicationScope = scope,
        cloudProjectNumber = BuildConfig.PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER,
        requireConfiguration = BuildConfig.REQUIRE_PLAY_INTEGRITY_CONFIGURATION,
    )
    private val database = Room.databaseBuilder(
        application,
        RafayPairDatabase::class.java,
        "rafaypair-offline.db",
    ).build()

    val authRepository: AuthRepository = DefaultAuthRepository(
        api = api,
        tokenVault = tokenVault,
        refreshToken = { refreshCoordinator.refresh(tokenVault.read()?.tokens?.accessToken) },
        preferences = preferences,
        applicationScope = scope,
        beforeLogout = { notificationDeviceRepository.unregisterCurrentDevice() },
    )
    val pairRepository: PairRepository = DefaultPairRepository(api, authRepository)
    val consentRepository: ConsentRepository = DefaultConsentRepository(api)
    val privacyRepository: PrivacyRepository = DefaultPrivacyRepository(
        api,
        preferences,
        scope,
        authRepository,
        pairRepository,
    )
    val careRepository: CareRepository = DefaultCareRepository(
        api,
        database.careDao(),
        SensitiveFieldCipher(),
        authRepository,
        pairRepository,
        consentRepository,
        privacyRepository,
    )
    val togetherRepository: TogetherRepository = DefaultTogetherRepository(api)
    val assistantRepository: AssistantRepository = DefaultAssistantRepository(api)
    val voiceClient = VoiceClient(api, json, scope)
    val realtimeRepository: RealtimeRepository = DefaultRealtimeRepository(
        api,
        json,
        preferences,
        scope,
        authRepository,
        pairRepository,
    )
    internal val reconnectSyncCoordinator = ReconnectSyncCoordinator(
        authRepository,
        pairRepository,
        privacyRepository,
        careRepository,
    )
    val pushCoordinator = PushCoordinator(
        application = application,
        firebaseAvailable = firebaseAvailable,
        store = pushRegistrationStore,
        authRepository = authRepository,
        careRepository = careRepository,
    )

    val viewModelFactory = MainViewModel.Factory(
        register = RegisterUseCase(authRepository),
        login = LoginUseCase(authRepository),
        authRepository = authRepository,
        pair = PairUseCases(pairRepository),
        pairRepository = pairRepository,
        consent = ConsentUseCases(consentRepository),
        consentRepository = consentRepository,
        care = CareUseCases(careRepository),
        careRepository = careRepository,
        privacy = PrivacyUseCases(privacyRepository),
        privacyRepository = privacyRepository,
        realtimeRepository = realtimeRepository,
        scheduleCareSync = { SyncScheduler.enqueueCare(application) },
        schedulePrivacySync = { SyncScheduler.enqueuePrivacy(application) },
        enablePushNotifications = pushCoordinator::enable,
    )

    init {
        scope.launch {
            authRepository.session
                .map { it is SessionState.SignedIn }
                .distinctUntilChanged()
                .collect { signedIn -> if (signedIn) pushCoordinator.resumeIfOptedIn() }
        }
        scope.launch {
            authRepository.session
                .map { (it as? SessionState.SignedIn)?.user?.id }
                .distinctUntilChanged()
                .collect { userId -> if (userId != null) playIntegrityCoordinator.assessAuthenticatedSession() }
        }
        scope.launch {
            combine(
                authRepository.session,
                pairRepository.pair,
                privacyRepository.state,
            ) { session, pair, privacy ->
                val ownerId = (session as? SessionState.SignedIn)?.user?.id
                val pairId = pair?.takeIf { it.status == PairStatus.ACTIVE }?.id
                ownerId != null &&
                    pairId != null &&
                    privacy.allowsSharing(ownerId, pairId)
            }.collect { shouldConnect ->
                if (shouldConnect) realtimeRepository.start() else realtimeRepository.stop()
            }
        }
        scope.launch {
            realtimeRepository.events.collect { type ->
                when (type) {
                    "care.request.created", "care.request.responded" -> careRepository.refresh()
                    "pair.disconnected" -> {
                        pairRepository.refresh()
                        consentRepository.clear()
                    }
                    "privacy.paused", "privacy.resumed" -> Unit
                }
            }
        }
    }
}

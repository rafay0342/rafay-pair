package com.rafaypair.android.data.repository

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.BackoffPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.rafaypair.android.RafayPairApplication
import com.rafaypair.android.domain.model.PairStatus
import com.rafaypair.android.domain.model.SessionState
import com.rafaypair.android.domain.repository.AuthRepository
import com.rafaypair.android.domain.repository.CareRepository
import com.rafaypair.android.domain.repository.PairRepository
import com.rafaypair.android.domain.repository.PartnerReplayReadiness
import com.rafaypair.android.domain.repository.PrivacyRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal class ReconnectSyncCoordinator(
    private val authRepository: AuthRepository,
    private val pairRepository: PairRepository,
    private val privacyRepository: PrivacyRepository,
    private val careRepository: CareRepository,
) {
    private val mutex = Mutex()

    suspend fun synchronizePrivacyThenCare(): Boolean = mutex.withLock {
        if (authRepository.session.value is SessionState.Restoring) authRepository.restore()
        if (authRepository.session.value !is SessionState.SignedIn) return@withLock true

        return@withLock try {
            pairRepository.refresh()
            if (pairRepository.pair.value?.status != PairStatus.ACTIVE) {
                privacyRepository.bindCurrentScope()
                true
            } else {
                when (privacyRepository.prepareForPartnerReplay()) {
                    PartnerReplayReadiness.ALLOWED -> careRepository.syncPending()
                    PartnerReplayReadiness.BLOCKED -> true
                    PartnerReplayReadiness.RETRY -> false
                }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            false
        }
    }
}

class CareSyncWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val container = (applicationContext as RafayPairApplication).container
        return if (container.reconnectSyncCoordinator.synchronizePrivacyThenCare()) Result.success() else Result.retry()
    }
}

class PrivacySyncWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val container = (applicationContext as RafayPairApplication).container
        return if (container.reconnectSyncCoordinator.synchronizePrivacyThenCare()) Result.success() else Result.retry()
    }
}

class PushTokenRegistrationWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val container = (applicationContext as RafayPairApplication).container
        if (container.authRepository.session.value is SessionState.Restoring) {
            container.authRepository.restore()
        }
        val user = (container.authRepository.session.value as? SessionState.SignedIn)?.user
            ?: return Result.success()
        return try {
            container.notificationDeviceRepository.registerCurrentToken(user.id)
            Result.success()
        } catch (_: Exception) {
            if (runAttemptCount < MAX_PUSH_ATTEMPTS) Result.retry() else Result.failure()
        }
    }
}

class CarePushWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val container = (applicationContext as RafayPairApplication).container
        return try {
            container.pushCoordinator.performAuthenticatedCareWake()
            Result.success()
        } catch (_: Exception) {
            if (runAttemptCount < MAX_PUSH_ATTEMPTS) Result.retry() else Result.failure()
        }
    }
}

object SyncScheduler {
    private val connected = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    fun enqueueCare(context: Context) {
        val request = OneTimeWorkRequestBuilder<CareSyncWorker>()
            .setConstraints(connected)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            "rafaypair-care-sync",
            ExistingWorkPolicy.KEEP,
            request,
        )
    }

    fun enqueuePrivacy(context: Context) {
        val request = OneTimeWorkRequestBuilder<PrivacySyncWorker>()
            .setConstraints(connected)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            "rafaypair-privacy-sync",
            ExistingWorkPolicy.REPLACE,
            request,
        )
    }

    fun enqueuePushToken(context: Context) {
        val request = OneTimeWorkRequestBuilder<PushTokenRegistrationWorker>()
            .setConstraints(connected)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, java.util.concurrent.TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            "rafaypair-push-token-registration",
            ExistingWorkPolicy.REPLACE,
            request,
        )
    }

    fun enqueueCarePush(context: Context) {
        val request = OneTimeWorkRequestBuilder<CarePushWorker>()
            .setConstraints(connected)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, java.util.concurrent.TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            "rafaypair-care-push-refetch",
            ExistingWorkPolicy.KEEP,
            request,
        )
    }
}

private const val MAX_PUSH_ATTEMPTS = 5

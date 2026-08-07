package com.rafaypair.android.notifications

import android.Manifest
import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessaging
import com.rafaypair.android.MainActivity
import com.rafaypair.android.R
import com.rafaypair.android.data.local.PushRegistrationStore
import com.rafaypair.android.data.repository.PushTokenPolicy
import com.rafaypair.android.data.repository.SyncScheduler
import com.rafaypair.android.domain.model.SessionState
import com.rafaypair.android.domain.repository.AuthRepository
import com.rafaypair.android.domain.repository.CareRepository

class PushCoordinator(
    private val application: Application,
    private val firebaseAvailable: Boolean,
    private val store: PushRegistrationStore,
    private val authRepository: AuthRepository,
    private val careRepository: CareRepository,
) {
    private val presenter = GenericCareNotificationPresenter(application)

    fun enable(): Boolean {
        if (!firebaseAvailable) return false
        store.setOptedIn(true)
        FirebaseMessaging.getInstance().isAutoInitEnabled = true
        requestRegistration()
        return true
    }

    fun resumeIfOptedIn() {
        if (!firebaseAvailable || !store.snapshot().optedIn) return
        FirebaseMessaging.getInstance().isAutoInitEnabled = true
        requestRegistration()
    }

    fun onRegistered(firebaseInstallationId: String) {
        if (!PushTokenPolicy.isValid(firebaseInstallationId)) return
        store.recordToken(firebaseInstallationId)
        if (store.snapshot().optedIn) SyncScheduler.enqueuePushToken(application)
    }

    fun shouldAcceptDataWake(data: Map<String, String>): Boolean = PushWakePolicy.accepts(data)

    suspend fun performAuthenticatedCareWake(): Boolean {
        if (authRepository.session.value is SessionState.Restoring) authRepository.restore()
        val signedIn = authRepository.session.value as? SessionState.SignedIn ?: return false
        val pending = careRepository.refreshForPush().toList()
        val unseen = store.recordFetchedPendingAndReturnUnseen(signedIn.user.id, pending)
        if (unseen.isNotEmpty()) presenter.show()
        return unseen.isNotEmpty()
    }

    private fun requestRegistration() {
        // Firebase Messaging 25.1+ targets app instances by Firebase Installation ID.
        // Completion invokes FirebaseMessagingService.onRegistered with the current FID.
        FirebaseMessaging.getInstance().register()
    }

}

object PushWakePolicy {
    private const val SYNC_KEY = "sync"
    private const val CARE_SYNC_VALUE = "care"

    fun accepts(data: Map<String, String>): Boolean =
        data.size == 1 && data[SYNC_KEY] == CARE_SYNC_VALUE
}

private class GenericCareNotificationPresenter(private val application: Application) {
    private val manager = NotificationManagerCompat.from(application)

    init {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            application.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Care updates",
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply {
                    description = "Private wake notifications that require an authenticated RafayPair refresh"
                    setShowBadge(true)
                },
            )
        }
    }

    fun show() {
        if (!manager.areNotificationsEnabled()) return
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(application, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) return

        val launchIntent = Intent(application, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            application,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(application, CHANNEL_ID)
            .setSmallIcon(R.drawable.rafaypair_monochrome)
            .setContentTitle("RafayPair")
            .setContentText("You have a new care update. Open RafayPair to view it.")
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(pendingIntent)
            .build()
        manager.notify(NOTIFICATION_ID, notification)
    }

    private companion object {
        const val CHANNEL_ID = "rafaypair-care-updates-v1"
        const val NOTIFICATION_ID = 0x524146
    }
}

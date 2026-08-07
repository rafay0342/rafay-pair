package com.rafaypair.android.notifications

import android.annotation.SuppressLint
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.rafaypair.android.RafayPairApplication
import com.rafaypair.android.data.repository.SyncScheduler

// Firebase Messaging 25.1 replaced token refresh with FID-based onRegistered(). The lint rule
// still requires the deprecated onNewToken callback and is inapplicable to this opted-in API.
@SuppressLint("MissingFirebaseInstanceTokenRefresh")
class RafayPairMessagingService : FirebaseMessagingService() {
    override fun onRegistered(installationId: String) {
        (application as RafayPairApplication).container.pushCoordinator.onRegistered(installationId)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val coordinator = (application as RafayPairApplication).container.pushCoordinator
        if (coordinator.shouldAcceptDataWake(message.data)) {
            SyncScheduler.enqueueCarePush(applicationContext)
        }
    }

    override fun onDeletedMessages() {
        val container = (application as RafayPairApplication).container
        if (container.pushRegistrationStore.snapshot().optedIn) {
            SyncScheduler.enqueueCarePush(applicationContext)
        }
    }
}

package com.rafaypair.android.data.repository

import com.rafaypair.android.data.local.AppPreferences
import com.rafaypair.android.data.local.PushRegistrationStore
import com.rafaypair.android.data.network.ApiClient
import com.rafaypair.android.data.network.ApiHttpException
import com.rafaypair.android.data.network.RegisterNotificationDeviceRequestDto

class NotificationDeviceRepository(
    private val api: ApiClient,
    private val store: PushRegistrationStore,
    private val preferences: AppPreferences,
) {
    suspend fun registerCurrentToken(userId: String) {
        val state = store.snapshot()
        val token = state.currentToken ?: return
        if (!state.optedIn || !PushTokenPolicy.isValid(token)) return

        val previousId = state.registeredDeviceId
        val response = api.registerNotificationDevice(
            RegisterNotificationDeviceRequestDto(
                platform = "android",
                token = token,
                installationId = preferences.installationId(),
            ),
        )
        store.recordRegistration(userId, token, response.device.id)

        if (previousId != null && previousId != response.device.id && state.registeredUserId == userId) {
            try {
                api.deleteNotificationDevice(previousId)
            } catch (error: ApiHttpException) {
                if (error.status != 404) return
            } catch (_: Exception) {
                // The current token is already active. A stale contentless registration is
                // harmless and will expire server-side if cleanup cannot complete now.
            }
        }
    }

    suspend fun unregisterCurrentDevice() {
        val deviceId = store.snapshot().registeredDeviceId
        if (deviceId != null) {
            try {
                api.deleteNotificationDevice(deviceId)
            } catch (error: ApiHttpException) {
                if (error.status != 404) throw error
            }
        }
        store.clearAccountState()
    }
}

object PushTokenPolicy {
    fun isValid(token: String): Boolean = token.length in 20..4096 && token.none(Char::isWhitespace)
}

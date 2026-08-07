package com.rafaypair.android.data.local

import android.annotation.SuppressLint
import android.content.Context
import java.nio.charset.StandardCharsets
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
private data class PersistedPushState(
    val optedIn: Boolean = false,
    val currentToken: String? = null,
    val registeredToken: String? = null,
    val registeredDeviceId: String? = null,
    val registeredUserId: String? = null,
    val seenCareRequestIds: List<String> = emptyList(),
)

data class PushRegistrationState(
    val optedIn: Boolean,
    val currentToken: String?,
    val registeredToken: String?,
    val registeredDeviceId: String?,
    val registeredUserId: String?,
)

object CarePushPolicy {
    fun unseenPendingIds(pendingIds: List<String>, seenIds: List<String>): List<String> {
        val seen = seenIds.toHashSet()
        return pendingIds.filterNot(seen::contains)
    }
}

class PushRegistrationStore(
    context: Context,
    private val json: Json,
) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val cipher = KeystoreCipher()

    @Synchronized
    fun snapshot(): PushRegistrationState = read().let { state ->
        PushRegistrationState(
            optedIn = state.optedIn,
            currentToken = state.currentToken,
            registeredToken = state.registeredToken,
            registeredDeviceId = state.registeredDeviceId,
            registeredUserId = state.registeredUserId,
        )
    }

    @Synchronized
    fun setOptedIn(enabled: Boolean) {
        save(read().copy(optedIn = enabled))
    }

    @Synchronized
    fun recordToken(token: String) {
        save(read().copy(currentToken = token))
    }

    @Synchronized
    fun recordRegistration(userId: String, token: String, deviceId: String) {
        val current = read()
        save(
            current.copy(
                registeredToken = token,
                registeredDeviceId = deviceId,
                registeredUserId = userId,
                seenCareRequestIds = if (current.registeredUserId == userId) {
                    current.seenCareRequestIds
                } else {
                    emptyList()
                },
            ),
        )
    }

    @Synchronized
    fun recordFetchedPendingAndReturnUnseen(userId: String, pendingIds: List<String>): List<String> {
        val current = read()
        val priorSeen = if (current.registeredUserId == userId) current.seenCareRequestIds else emptyList()
        val unseen = CarePushPolicy.unseenPendingIds(pendingIds, priorSeen)
        val pendingSet = pendingIds.toHashSet()
        val bounded = (pendingIds + priorSeen.filterNot(pendingSet::contains)).distinct().take(MAX_SEEN_IDS)
        save(
            current.copy(
                registeredUserId = userId,
                seenCareRequestIds = bounded,
            ),
        )
        return unseen
    }

    @Synchronized
    fun clearAccountState() {
        val current = read()
        save(
            PersistedPushState(
                optedIn = current.optedIn,
                currentToken = current.currentToken,
            ),
        )
    }

    @SuppressLint("ApplySharedPref", "UseKtx")
    private fun read(): PersistedPushState {
        val encrypted = preferences.getString(BLOB_KEY, null) ?: return PersistedPushState()
        return runCatching {
            val cleartext = cipher.decrypt(KEY_ALIAS, encrypted)
            json.decodeFromString<PersistedPushState>(cleartext.toString(StandardCharsets.UTF_8))
        }.getOrElse {
            // Synchronous removal prevents a delayed apply() from erasing the replacement
            // ciphertext written immediately after recovery from a corrupt entry.
            preferences.edit().remove(BLOB_KEY).commit()
            cipher.delete(KEY_ALIAS)
            PersistedPushState()
        }
    }

    @SuppressLint("ApplySharedPref", "UseKtx")
    private fun save(state: PersistedPushState) {
        val cleartext = json.encodeToString(PersistedPushState.serializer(), state)
            .toByteArray(StandardCharsets.UTF_8)
        try {
            val encrypted = cipher.encrypt(KEY_ALIAS, cleartext)
            check(preferences.edit().putString(BLOB_KEY, encrypted).commit()) {
                "Unable to persist push registration state"
            }
        } finally {
            cleartext.fill(0)
        }
    }

    private companion object {
        const val PREFERENCES = "rafaypair.secure.push"
        const val BLOB_KEY = "encrypted_push_state"
        const val KEY_ALIAS = "rafaypair.push.registration.v1"
        const val MAX_SEEN_IDS = 512
    }
}

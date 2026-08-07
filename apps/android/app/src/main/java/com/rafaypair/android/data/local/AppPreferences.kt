package com.rafaypair.android.data.local

import android.content.Context
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.rafaypair.android.domain.model.PrivacyState
import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private val Context.dataStore by preferencesDataStore(name = "rafaypair_preferences")

data class AccountPairScope(
    val ownerUserId: String,
    val pairId: String,
)

class AppPreferences(private val context: Context) {
    private val installationIdMutex = Mutex()

    val privacy: Flow<PrivacyState> = context.dataStore.data.map(::privacyState)

    /**
     * Establishes the only account allowed to own device-persistent partner state. Switching the
     * account clears the prior pair, privacy intent, and realtime cursor in the same DataStore
     * transaction before the new account can be exposed to repositories.
     */
    suspend fun activateAccount(ownerUserId: String) {
        requireIdentifier(ownerUserId, "owner user")
        context.dataStore.edit { values ->
            if (values[ACCOUNT_OWNER_USER_ID] != ownerUserId) {
                clearAccountValues(values)
                values[ACCOUNT_OWNER_USER_ID] = ownerUserId
            }
        }
    }

    /**
     * Binds privacy and replay state to one exact active pair. A new or repaired scope starts
     * fail-closed until an authenticated server response confirms its privacy state.
     */
    suspend fun bindPairScope(scope: AccountPairScope): Boolean {
        requireScope(scope)
        var bound = false
        context.dataStore.edit { values ->
            if (values[ACCOUNT_OWNER_USER_ID] != scope.ownerUserId) {
                clearAccountValues(values)
                return@edit
            }
            val unchanged =
                values[PAIR_SCOPE_OWNER_USER_ID] == scope.ownerUserId &&
                    values[PAIR_SCOPE_PAIR_ID] == scope.pairId
            if (!unchanged) {
                clearPairValues(values)
                values[PAIR_SCOPE_OWNER_USER_ID] = scope.ownerUserId
                values[PAIR_SCOPE_PAIR_ID] = scope.pairId
                values[PRIVACY_EFFECTIVE] = true
                values[PRIVACY_DESIRED] = true
                values[PRIVACY_PENDING] = false
                values[PRIVACY_BOUNDARY_READY] = false
            }
            bound = true
        }
        return bound
    }

    suspend fun clearPairScope(ownerUserId: String) {
        requireIdentifier(ownerUserId, "owner user")
        context.dataStore.edit { values ->
            if (values[ACCOUNT_OWNER_USER_ID] == ownerUserId) {
                clearPairValues(values)
            } else {
                clearAccountValues(values)
            }
        }
    }

    /** Atomically removes all partner-visible state when the server rejects or mismatches a scope. */
    suspend fun invalidatePairScope(scope: AccountPairScope): Boolean {
        requireScope(scope)
        var invalidated = false
        context.dataStore.edit { values ->
            if (!values.matches(scope)) return@edit
            clearPairValues(values)
            invalidated = true
        }
        return invalidated
    }

    suspend fun privacyState(): PrivacyState = privacy.first()

    suspend fun privacyState(scope: AccountPairScope): PrivacyState {
        requireScope(scope)
        val current = privacy.first()
        return if (current.matches(scope)) current else PrivacyState()
    }

    suspend fun requestPrivacy(scope: AccountPairScope, paused: Boolean): Boolean {
        requireScope(scope)
        var updated = false
        context.dataStore.edit { values ->
            if (!values.matches(scope)) return@edit
            values[PRIVACY_DESIRED] = paused
            values[PRIVACY_PENDING] = true
            values[PRIVACY_BOUNDARY_READY] = true
            if (paused) values[PRIVACY_EFFECTIVE] = true
            updated = true
        }
        return updated
    }

    suspend fun confirmPrivacy(scope: AccountPairScope, paused: Boolean): Boolean {
        requireScope(scope)
        var updated = false
        context.dataStore.edit { values ->
            if (!values.matches(scope)) return@edit
            values[PRIVACY_EFFECTIVE] = paused
            values[PRIVACY_DESIRED] = paused
            values[PRIVACY_PENDING] = false
            values[PRIVACY_BOUNDARY_READY] = true
            updated = true
        }
        return updated
    }

    suspend fun realtimeCursor(scope: AccountPairScope): String? {
        requireScope(scope)
        val values = context.dataStore.data.first()
        if (!values.matches(scope)) return null
        if (
            values[REALTIME_CURSOR_OWNER_USER_ID] != scope.ownerUserId ||
            values[REALTIME_CURSOR_PAIR_ID] != scope.pairId
        ) {
            return null
        }
        return values[REALTIME_CURSOR]
    }

    suspend fun setRealtimeCursor(scope: AccountPairScope, cursor: String): Boolean {
        requireScope(scope)
        val nextCursor = cursor.toLongOrNull()
        require(nextCursor != null && nextCursor >= 0) { "Realtime cursor must be a non-negative integer" }
        var updated = false
        context.dataStore.edit { values ->
            if (!values.matches(scope)) return@edit
            val currentCursor = values[REALTIME_CURSOR]?.toLongOrNull()
            if (currentCursor != null && nextCursor <= currentCursor) return@edit
            values[REALTIME_CURSOR_OWNER_USER_ID] = scope.ownerUserId
            values[REALTIME_CURSOR_PAIR_ID] = scope.pairId
            values[REALTIME_CURSOR] = cursor
            updated = true
        }
        return updated
    }

    suspend fun installationId(): String = installationIdMutex.withLock {
        val existing = context.dataStore.data.first()[INSTALLATION_ID]
        if (existing != null) return@withLock existing
        val generated = UUID.randomUUID().toString()
        context.dataStore.edit { it[INSTALLATION_ID] = generated }
        generated
    }

    suspend fun clearAccountState() {
        context.dataStore.edit(::clearAccountValues)
    }

    private fun privacyState(values: androidx.datastore.preferences.core.Preferences): PrivacyState {
        val accountOwner = values[ACCOUNT_OWNER_USER_ID]
        val scopeOwner = values[PAIR_SCOPE_OWNER_USER_ID]
        val pairId = values[PAIR_SCOPE_PAIR_ID]
        if (accountOwner == null || accountOwner != scopeOwner || pairId == null) return PrivacyState()
        return PrivacyState(
            ownerUserId = scopeOwner,
            pairId = pairId,
            isPaused = values[PRIVACY_EFFECTIVE] ?: true,
            desiredPaused = values[PRIVACY_DESIRED] ?: true,
            syncPending = values[PRIVACY_PENDING] ?: false,
            boundaryReady = values[PRIVACY_BOUNDARY_READY] ?: false,
        )
    }

    private fun androidx.datastore.preferences.core.Preferences.matches(scope: AccountPairScope): Boolean =
        this[ACCOUNT_OWNER_USER_ID] == scope.ownerUserId &&
            this[PAIR_SCOPE_OWNER_USER_ID] == scope.ownerUserId &&
            this[PAIR_SCOPE_PAIR_ID] == scope.pairId

    private fun PrivacyState.matches(scope: AccountPairScope): Boolean =
        ownerUserId == scope.ownerUserId && pairId == scope.pairId

    private fun requireScope(scope: AccountPairScope) {
        requireIdentifier(scope.ownerUserId, "owner user")
        requireIdentifier(scope.pairId, "pair")
    }

    private fun requireIdentifier(value: String, label: String) {
        require(runCatching { UUID.fromString(value) }.getOrNull()?.toString() == value.lowercase()) {
            "$label identifier must be a canonical UUID"
        }
    }

    private fun clearAccountValues(values: MutablePreferences) {
        clearPairValues(values)
        values.remove(ACCOUNT_OWNER_USER_ID)
    }

    private fun clearPairValues(values: MutablePreferences) {
        values.remove(PAIR_SCOPE_OWNER_USER_ID)
        values.remove(PAIR_SCOPE_PAIR_ID)
        values.remove(PRIVACY_EFFECTIVE)
        values.remove(PRIVACY_DESIRED)
        values.remove(PRIVACY_PENDING)
        values.remove(PRIVACY_BOUNDARY_READY)
        values.remove(REALTIME_CURSOR_OWNER_USER_ID)
        values.remove(REALTIME_CURSOR_PAIR_ID)
        values.remove(REALTIME_CURSOR)
    }

    private companion object {
        val ACCOUNT_OWNER_USER_ID = stringPreferencesKey("account_owner_user_id")
        val PAIR_SCOPE_OWNER_USER_ID = stringPreferencesKey("pair_scope_owner_user_id")
        val PAIR_SCOPE_PAIR_ID = stringPreferencesKey("pair_scope_pair_id")
        val PRIVACY_EFFECTIVE = booleanPreferencesKey("privacy_effective_paused")
        val PRIVACY_DESIRED = booleanPreferencesKey("privacy_desired_paused")
        val PRIVACY_PENDING = booleanPreferencesKey("privacy_sync_pending")
        val PRIVACY_BOUNDARY_READY = booleanPreferencesKey("privacy_boundary_ready")
        val REALTIME_CURSOR_OWNER_USER_ID = stringPreferencesKey("realtime_cursor_owner_user_id")
        val REALTIME_CURSOR_PAIR_ID = stringPreferencesKey("realtime_cursor_pair_id")
        val REALTIME_CURSOR = stringPreferencesKey("realtime_cursor")
        val INSTALLATION_ID = stringPreferencesKey("installation_id")
    }
}

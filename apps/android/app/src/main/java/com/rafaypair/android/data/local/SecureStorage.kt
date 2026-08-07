package com.rafaypair.android.data.local

import android.annotation.SuppressLint
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.rafaypair.android.domain.model.AuthTokens
import com.rafaypair.android.domain.model.User
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.time.Clock
import java.time.Duration
import java.time.Instant
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

private const val ANDROID_KEYSTORE = "AndroidKeyStore"
private const val TRANSFORMATION = "AES/GCM/NoPadding"

internal class KeystoreCipher {
    fun encrypt(alias: String, plaintext: ByteArray): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey(alias))
        val encrypted = cipher.doFinal(plaintext)
        return listOf(
            Base64.encodeToString(cipher.iv, Base64.NO_WRAP),
            Base64.encodeToString(encrypted, Base64.NO_WRAP),
        ).joinToString(".")
    }

    fun decrypt(alias: String, payload: String): ByteArray {
        val (iv, ciphertext) = payload.split('.', limit = 2).also {
            require(it.size == 2) { "Invalid encrypted value" }
        }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            getExistingKey(alias) ?: throw IllegalStateException("Encryption key unavailable"),
            GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)),
        )
        return cipher.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP))
    }

    fun delete(alias: String) {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias)
    }

    private fun getExistingKey(alias: String): SecretKey? {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        return keyStore.getKey(alias, null) as? SecretKey
    }

    private fun getOrCreateKey(alias: String): SecretKey = getExistingKey(alias) ?: KeyGenerator
        .getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        .apply {
            init(
                KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
        }
        .generateKey()
}

@Serializable
private data class PersistedSession(
    val userId: String,
    val email: String,
    val displayName: String,
    val accessToken: String,
    val refreshToken: String,
    val accessTokenExpiresAt: String,
    val refreshTokenExpiresAt: String,
)

data class StoredSession(val user: User, val tokens: AuthTokens)

class RotatingTokenVault(
    context: Context,
    private val json: Json,
    private val clock: Clock = Clock.systemUTC(),
) {
    private val preferences = context.getSharedPreferences("rafaypair.secure.session", Context.MODE_PRIVATE)
    private val cipher = KeystoreCipher()
    private val mutableHasSession = MutableStateFlow(preferences.contains(BLOB_KEY))
    val hasSession: StateFlow<Boolean> = mutableHasSession

    @Synchronized
    fun read(): StoredSession? {
        val stored = preferences.getString(BLOB_KEY, null) ?: return null
        return runCatching {
            val separator = stored.indexOf(':')
            require(separator > 0) { "Missing key generation" }
            val generation = stored.substring(0, separator).toLong()
            val payload = stored.substring(separator + 1)
            val cleartext = cipher.decrypt(alias(generation), payload)
            val persisted = json.decodeFromString<PersistedSession>(
                cleartext.toString(StandardCharsets.UTF_8),
            )
            val session = persisted.toDomain()
            if (generation != currentGeneration()) {
                save(session.user, session.tokens)
                cipher.delete(alias(generation))
            }
            session
        }.getOrElse {
            clear()
            null
        }
    }

    @SuppressLint("ApplySharedPref", "UseKtx")
    @Synchronized
    fun save(user: User, tokens: AuthTokens) {
        val generation = currentGeneration()
        val persisted = PersistedSession(
            userId = user.id,
            email = user.email,
            displayName = user.displayName,
            accessToken = tokens.accessToken,
            refreshToken = tokens.refreshToken,
            accessTokenExpiresAt = tokens.accessTokenExpiresAt.toString(),
            refreshTokenExpiresAt = tokens.refreshTokenExpiresAt.toString(),
        )
        val plaintext = json.encodeToString(PersistedSession.serializer(), persisted)
            .toByteArray(StandardCharsets.UTF_8)
        val encrypted = cipher.encrypt(alias(generation), plaintext)
        check(preferences.edit().putString(BLOB_KEY, "$generation:$encrypted").commit()) {
            "Unable to persist authenticated session"
        }
        mutableHasSession.value = true
        plaintext.fill(0)
    }

    @SuppressLint("ApplySharedPref", "UseKtx")
    @Synchronized
    fun clear() {
        val storedGeneration = preferences.getString(BLOB_KEY, null)
            ?.substringBefore(':')
            ?.toLongOrNull()
        preferences.edit().clear().commit()
        mutableHasSession.value = false
        storedGeneration?.let { cipher.delete(alias(it)) }
        cipher.delete(alias(currentGeneration()))
    }

    private fun currentGeneration(): Long = Duration.between(EPOCH, clock.instant()).toDays() / ROTATION_DAYS

    private fun alias(generation: Long): String = "rafaypair.auth.tokens.$generation"

    private fun PersistedSession.toDomain(): StoredSession {
        val user = User(id = userId, email = email, displayName = displayName)
        return StoredSession(
            user = user,
            tokens = AuthTokens(
                accessToken = accessToken,
                refreshToken = refreshToken,
                accessTokenExpiresAt = Instant.parse(accessTokenExpiresAt),
                refreshTokenExpiresAt = Instant.parse(refreshTokenExpiresAt),
                userId = userId,
            ),
        )
    }

    private companion object {
        const val BLOB_KEY = "encrypted_session"
        const val ROTATION_DAYS = 90L
        val EPOCH: Instant = Instant.parse("2020-01-01T00:00:00Z")
    }
}

class SensitiveFieldCipher {
    private val cipher = KeystoreCipher()

    fun encrypt(value: String?): String? = value?.let {
        cipher.encrypt(ALIAS, it.toByteArray(StandardCharsets.UTF_8))
    }

    fun decrypt(value: String?): String? = value?.let {
        runCatching { cipher.decrypt(ALIAS, it).toString(StandardCharsets.UTF_8) }.getOrNull()
    }

    private companion object {
        const val ALIAS = "rafaypair.local.care.v1"
    }
}

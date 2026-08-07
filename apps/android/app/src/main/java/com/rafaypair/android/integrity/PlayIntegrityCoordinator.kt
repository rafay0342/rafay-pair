package com.rafaypair.android.integrity

import android.app.Application
import com.google.android.gms.tasks.Task
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityException
import com.google.android.play.core.integrity.StandardIntegrityManager
import com.google.android.play.core.integrity.model.StandardIntegrityErrorCode
import com.rafaypair.android.data.network.AndroidIntegrityAssessmentRequestDto
import com.rafaypair.android.data.network.ApiClient
import java.security.MessageDigest
import java.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

enum class PlayIntegrityCapability { PREPARING, READY, UNSUPPORTED, UNAVAILABLE }

/**
 * Warms and owns Google's Standard Integrity provider in memory. Tokens are requested only for a
 * short-lived backend challenge, sent directly to the API, and are never logged or persisted.
 * Assessment failure cannot grant or revoke authorization; it is an independent backend risk signal.
 */
class PlayIntegrityCoordinator(
    application: Application,
    private val api: ApiClient,
    private val applicationScope: CoroutineScope,
    cloudProjectNumber: Long,
    requireConfiguration: Boolean,
) {
    private val configured = cloudProjectNumber > 0L
    private val manager: StandardIntegrityManager? = if (configured) {
        IntegrityManagerFactory.createStandard(application)
    } else {
        null
    }
    private val projectNumber = cloudProjectNumber
    private val providerMutex = Mutex()
    private val assessmentMutex = Mutex()
    private var provider: StandardIntegrityManager.StandardIntegrityTokenProvider? = null
    private val mutableCapability = MutableStateFlow(
        if (configured) PlayIntegrityCapability.PREPARING else PlayIntegrityCapability.UNSUPPORTED,
    )
    val capability: StateFlow<PlayIntegrityCapability> = mutableCapability

    init {
        check(!requireConfiguration || configured) {
            "A production Android build is missing its Play Integrity Cloud project number"
        }
        if (configured) applicationScope.launch { prepareProvider() }
    }

    fun assessAuthenticatedSession() {
        if (!configured) return
        applicationScope.launch {
            assessmentMutex.withLock {
                try {
                    assessSessionStart()
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    // Authorization is independent. A future authenticated session can
                    // request a fresh signal; provider tokens and errors are never logged.
                }
            }
        }
    }

    private suspend fun assessSessionStart() {
        var currentProvider = prepareProvider() ?: return
        val challenge = api.createAndroidIntegrityChallenge().challenge
        if (challenge.action != SESSION_START_ACTION || challenge.bindingVersion != BINDING_VERSION) return
        val requestHash = requestHash(challenge.id, challenge.action)
        val token = try {
            requestToken(currentProvider, requestHash)
        } catch (error: StandardIntegrityException) {
            if (error.errorCode != StandardIntegrityErrorCode.INTEGRITY_TOKEN_PROVIDER_INVALID) throw error
            providerMutex.withLock { provider = null }
            currentProvider = prepareProvider() ?: return
            requestToken(currentProvider, requestHash)
        }
        api.submitAndroidIntegrityAssessment(
            AndroidIntegrityAssessmentRequestDto(
                challengeId = challenge.id,
                action = challenge.action,
                integrityToken = token,
            ),
        )
    }

    private suspend fun prepareProvider(): StandardIntegrityManager.StandardIntegrityTokenProvider? =
        providerMutex.withLock {
            provider?.let { return@withLock it }
            val currentManager = manager ?: return@withLock null
            mutableCapability.value = PlayIntegrityCapability.PREPARING
            try {
                val prepared = withTimeout(PREPARE_TIMEOUT_MILLISECONDS) {
                    currentManager.prepareIntegrityToken(
                        StandardIntegrityManager.PrepareIntegrityTokenRequest.builder()
                            .setCloudProjectNumber(projectNumber)
                            .build(),
                    ).awaitResult()
                }
                provider = prepared
                mutableCapability.value = PlayIntegrityCapability.READY
                prepared
            } catch (_: TimeoutCancellationException) {
                mutableCapability.value = PlayIntegrityCapability.UNAVAILABLE
                null
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                mutableCapability.value = PlayIntegrityCapability.UNAVAILABLE
                null
            }
        }

    private suspend fun requestToken(
        currentProvider: StandardIntegrityManager.StandardIntegrityTokenProvider,
        requestHash: String,
    ): String = withTimeout(TOKEN_TIMEOUT_MILLISECONDS) {
        currentProvider.request(
            StandardIntegrityManager.StandardIntegrityTokenRequest.builder()
                .setRequestHash(requestHash)
                .build(),
        ).awaitResult().token()
    }

    companion object {
        private const val SESSION_START_ACTION = "session_start"
        private const val BINDING_VERSION = "sha256-v1"
        private const val PREPARE_TIMEOUT_MILLISECONDS = 60_000L
        private const val TOKEN_TIMEOUT_MILLISECONDS = 15_000L

        internal fun requestHash(challengeId: String, action: String): String {
            val canonical = listOf(
                "rafaypair.play-integrity.v1",
                "POST",
                "/v1/integrity/android/assessments",
                challengeId,
                action,
            ).joinToString("\n")
            val digest = MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray(Charsets.UTF_8))
            return Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
        }
    }
}

private suspend fun <T> Task<T>.awaitResult(): T = suspendCancellableCoroutine { continuation ->
    addOnCompleteListener { task ->
        if (!continuation.isActive) return@addOnCompleteListener
        when {
            task.isSuccessful -> continuation.resume(requireNotNull(task.result))
            task.isCanceled -> continuation.cancel()
            else -> continuation.resumeWithException(task.exception ?: IllegalStateException("Google Play task failed"))
        }
    }
}

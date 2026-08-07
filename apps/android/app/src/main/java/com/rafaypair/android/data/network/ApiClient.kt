package com.rafaypair.android.data.network

import com.rafaypair.android.BuildConfig
import com.rafaypair.android.data.local.RotatingTokenVault
import java.io.IOException
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import okhttp3.Authenticator
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.Route
import okhttp3.HttpUrl.Companion.toHttpUrl

class ApiHttpException(
    val status: Int,
    val problem: ProblemDetailsDto,
) : IOException(problem.detail ?: problem.title)

class ApiNetworkException(cause: IOException) : IOException("Could not reach RafayPair", cause)

private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

class RefreshCoordinator(
    private val baseUrl: String,
    private val json: Json,
    private val tokenVault: RotatingTokenVault,
    private val rawClient: OkHttpClient,
) {
    private val lock = Any()

    fun refresh(expectedAccessToken: String?): String? = synchronized(lock) {
        val existing = tokenVault.read() ?: return@synchronized null
        if (expectedAccessToken != null && existing.tokens.accessToken != expectedAccessToken) {
            return@synchronized existing.tokens.accessToken
        }
        if (existing.tokens.refreshTokenExpiresAt <= Instant.now()) {
            tokenVault.clear()
            return@synchronized null
        }
        val requestBody = json.encodeToString(
            RefreshRequestDto.serializer(),
            RefreshRequestDto(existing.tokens.refreshToken),
        )
        val request = Request.Builder()
            .url("${baseUrl.trimEnd('/')}/v1/auth/refresh")
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .header("X-Rafay-Client", "android")
            .post(requestBody.toRequestBody(JSON_MEDIA_TYPE))
            .build()
        val response = runCatching { rawClient.newCall(request).execute() }.getOrNull() ?: return@synchronized null
        response.use {
            if (!it.isSuccessful) {
                if (it.code == 400 || it.code == 401 || it.code == 403) tokenVault.clear()
                return@synchronized null
            }
            val body = it.body.string()
            val refreshed = runCatching { json.decodeFromString(AuthResponseDto.serializer(), body) }.getOrNull()
                ?: return@synchronized null
            val tokens = refreshed.toDomainTokens()
            tokenVault.save(refreshed.user.toDomain(), tokens)
            tokens.accessToken
        }
    }
}

private class BearerInterceptor(private val tokenVault: RotatingTokenVault) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        val noAuth = original.header("X-Rafay-No-Auth") != null
        val token = tokenVault.read()?.tokens?.accessToken
        val request = original.newBuilder()
            .removeHeader("X-Rafay-No-Auth")
            .header("Accept", "application/json")
            .header("X-Rafay-Client", "android")
            .apply { if (!noAuth && token != null && original.header("Authorization") == null) bearer(token) }
            .build()
        return chain.proceed(request)
    }

    private fun Request.Builder.bearer(token: String) = header("Authorization", "Bearer $token")
}

private class RefreshAuthenticator(
    private val tokenVault: RotatingTokenVault,
    private val coordinator: RefreshCoordinator,
) : Authenticator {
    override fun authenticate(route: Route?, response: Response): Request? {
        if (response.retryCount() >= 2) return null
        val previous = response.request.header("Authorization")?.removePrefix("Bearer ")
        val token = coordinator.refresh(previous) ?: return null
        if (token == previous && tokenVault.read()?.tokens?.accessToken == previous) return null
        return response.request.newBuilder().header("Authorization", "Bearer $token").build()
    }

    private fun Response.retryCount(): Int {
        var count = 1
        var current = priorResponse
        while (current != null) {
            count += 1
            current = current.priorResponse
        }
        return count
    }
}

class ApiClient(
    private val baseUrl: String,
    private val json: Json,
    tokenVault: RotatingTokenVault,
    refreshCoordinator: RefreshCoordinator,
) {
    val okHttpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .addInterceptor(BearerInterceptor(tokenVault))
        .authenticator(RefreshAuthenticator(tokenVault, refreshCoordinator))
        .build()

    suspend fun register(request: RegisterRequestDto): AuthResponseDto = post(
        "/v1/auth/register",
        request,
        RegisterRequestDto.serializer(),
        AuthResponseDto.serializer(),
        authenticated = false,
    )

    suspend fun login(request: LoginRequestDto): AuthResponseDto = post(
        "/v1/auth/login",
        request,
        LoginRequestDto.serializer(),
        AuthResponseDto.serializer(),
        authenticated = false,
    )

    suspend fun logout(request: LogoutRequestDto) = postWithoutResponse(
        "/v1/auth/logout",
        request,
        LogoutRequestDto.serializer(),
    )

    suspend fun currentPair(): PairResponseDto = get("/v1/pairs/current", PairResponseDto.serializer())

    suspend fun createPair(): PairResponseDto = post(
        "/v1/pairs/current",
        EmptyRequestDto(),
        EmptyRequestDto.serializer(),
        PairResponseDto.serializer(),
    )

    suspend fun joinPair(code: String): PairResponseDto = post(
        "/v1/pairs/join",
        JoinPairRequestDto(code),
        JoinPairRequestDto.serializer(),
        PairResponseDto.serializer(),
    )

    suspend fun disconnectPair() = delete("/v1/pairs/current")

    suspend fun consents(): ConsentResponseDto = get("/v1/consents", ConsentResponseDto.serializer())

    suspend fun updateConsents(request: UpdateConsentsRequestDto): ConsentResponseDto = put(
        "/v1/consents",
        request,
        UpdateConsentsRequestDto.serializer(),
        ConsentResponseDto.serializer(),
    )

    suspend fun careRequests(): CareRequestListResponseDto = get(
        "/v1/care-requests?limit=100",
        CareRequestListResponseDto.serializer(),
    )

    suspend fun sendCare(request: CreateCareRequestDto): CareRequestResponseDto = post(
        "/v1/care-requests",
        request,
        CreateCareRequestDto.serializer(),
        CareRequestResponseDto.serializer(),
    )

    suspend fun respondCare(id: String, request: RespondCareRequestDto): CareRequestResponseDto = post(
        "/v1/care-requests/$id/respond",
        request,
        RespondCareRequestDto.serializer(),
        CareRequestResponseDto.serializer(),
    )

    suspend fun setPrivacyPaused(paused: Boolean): PrivacyResponseDto = post(
        if (paused) "/v1/privacy/pause" else "/v1/privacy/resume",
        EmptyRequestDto(),
        EmptyRequestDto.serializer(),
        PrivacyResponseDto.serializer(),
    )

    suspend fun privacy(): PrivacyResponseDto = get("/v1/privacy", PrivacyResponseDto.serializer())

    suspend fun realtimeTicket(lastEventId: String?): RealtimeTicketResponseDto = post(
        "/v1/realtime/tickets",
        RealtimeTicketRequestDto(lastEventId),
        RealtimeTicketRequestDto.serializer(),
        RealtimeTicketResponseDto.serializer(),
    )

    suspend fun registerNotificationDevice(
        request: RegisterNotificationDeviceRequestDto,
    ): NotificationDeviceResponseDto = post(
        "/v1/notification-devices",
        request,
        RegisterNotificationDeviceRequestDto.serializer(),
        NotificationDeviceResponseDto.serializer(),
    )

    suspend fun createAndroidIntegrityChallenge(): AndroidIntegrityChallengeResponseDto = post(
        "/v1/integrity/android/challenges",
        AndroidIntegrityChallengeRequestDto(action = "session_start"),
        AndroidIntegrityChallengeRequestDto.serializer(),
        AndroidIntegrityChallengeResponseDto.serializer(),
    )

    suspend fun submitAndroidIntegrityAssessment(
        request: AndroidIntegrityAssessmentRequestDto,
    ): AndroidIntegrityAssessmentResponseDto = post(
        "/v1/integrity/android/assessments",
        request,
        AndroidIntegrityAssessmentRequestDto.serializer(),
        AndroidIntegrityAssessmentResponseDto.serializer(),
    )

    suspend fun deleteNotificationDevice(id: String) {
        val validated = UUID.fromString(id).toString()
        delete("/v1/notification-devices/$validated")
    }

    private suspend fun <T> get(path: String, responseSerializer: KSerializer<T>): T =
        execute(Request.Builder().url(url(path)).get().build(), responseSerializer)

    private suspend fun <I, O> post(
        path: String,
        body: I,
        requestSerializer: KSerializer<I>,
        responseSerializer: KSerializer<O>,
        authenticated: Boolean = true,
    ): O {
        val requestBody = json.encodeToString(requestSerializer, body).toRequestBody(JSON_MEDIA_TYPE)
        val request = Request.Builder().url(url(path)).post(requestBody).apply {
            if (!authenticated) header("X-Rafay-No-Auth", "true")
        }.build()
        return execute(request, responseSerializer)
    }

    private suspend fun <I, O> put(
        path: String,
        body: I,
        requestSerializer: KSerializer<I>,
        responseSerializer: KSerializer<O>,
    ): O {
        val requestBody = json.encodeToString(requestSerializer, body).toRequestBody(JSON_MEDIA_TYPE)
        return execute(Request.Builder().url(url(path)).put(requestBody).build(), responseSerializer)
    }

    private suspend fun <I> postWithoutResponse(
        path: String,
        body: I,
        requestSerializer: KSerializer<I>,
    ) {
        val requestBody = json.encodeToString(requestSerializer, body).toRequestBody(JSON_MEDIA_TYPE)
        executeWithoutResponse(Request.Builder().url(url(path)).post(requestBody).build())
    }

    private suspend fun delete(path: String) {
        executeWithoutResponse(Request.Builder().url(url(path)).delete().build())
    }

    private suspend fun <T> execute(request: Request, serializer: KSerializer<T>): T =
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            val response = try {
                okHttpClient.newCall(request).execute()
            } catch (error: IOException) {
                throw ApiNetworkException(error)
            }
            response.use {
                val body = it.body.string()
                if (!it.isSuccessful) throw it.toException(body)
                try {
                    json.decodeFromString(serializer, body)
                } catch (error: Exception) {
                    throw IOException("RafayPair returned an invalid response", error)
                }
            }
        }

    private suspend fun executeWithoutResponse(request: Request) =
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            val response = try {
                okHttpClient.newCall(request).execute()
            } catch (error: IOException) {
                throw ApiNetworkException(error)
            }
            response.use {
                val body = it.body.string()
                if (!it.isSuccessful) throw it.toException(body)
            }
        }

    private fun Response.toException(body: String): ApiHttpException {
        val problem = runCatching { json.decodeFromString(ProblemDetailsDto.serializer(), body) }.getOrNull()
            ?: ProblemDetailsDto(
                title = "Request failed",
                status = code,
                detail = if (code >= 500) "RafayPair is temporarily unavailable." else null,
                code = "http_$code",
            )
        return ApiHttpException(code, problem)
    }

    private fun url(path: String): String = "${baseUrl.trimEnd('/')}/${path.trimStart('/')}"
}

internal fun UserDto.toDomain() = com.rafaypair.android.domain.model.User(id, email, displayName)

internal fun AuthResponseDto.toDomainTokens(): com.rafaypair.android.domain.model.AuthTokens {
    val access = requireNotNull(session.accessToken) { "Mobile auth response omitted access token" }
    val refresh = requireNotNull(session.refreshToken) { "Mobile auth response omitted refresh token" }
    return com.rafaypair.android.domain.model.AuthTokens(
        accessToken = access,
        refreshToken = refresh,
        accessTokenExpiresAt = Instant.parse(session.accessTokenExpiresAt),
        refreshTokenExpiresAt = Instant.parse(session.refreshTokenExpiresAt),
        userId = user.id,
    )
}

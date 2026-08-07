package com.rafaypair.android.domain.usecase

import com.rafaypair.android.domain.model.CareKind
import com.rafaypair.android.domain.model.CareResponse
import com.rafaypair.android.domain.model.ConsentCapability
import com.rafaypair.android.domain.repository.AuthRepository
import com.rafaypair.android.domain.repository.CareRepository
import com.rafaypair.android.domain.repository.ConsentRepository
import com.rafaypair.android.domain.repository.PairRepository
import com.rafaypair.android.domain.repository.PrivacyRepository

class RegisterUseCase(private val repository: AuthRepository) {
    suspend operator fun invoke(displayName: String, email: String, password: String) =
        repository.register(displayName.trim(), email.trim().lowercase(), password)
}

class LoginUseCase(private val repository: AuthRepository) {
    suspend operator fun invoke(email: String, password: String) =
        repository.login(email.trim().lowercase(), password)
}

class LogoutUseCase(private val repository: AuthRepository) {
    suspend operator fun invoke() = repository.logout()
}

class PairUseCases(private val repository: PairRepository) {
    suspend fun create() = repository.create()
    suspend fun join(code: String) = repository.join(code.trim().uppercase())
    suspend fun disconnect() = repository.disconnect()
    suspend fun refresh() = repository.refresh()
}

class ConsentUseCases(private val repository: ConsentRepository) {
    suspend fun refresh() = repository.refresh()
    suspend fun update(capability: ConsentCapability, granted: Boolean) =
        repository.update(capability, granted)
}

class CareUseCases(private val repository: CareRepository) {
    suspend fun refresh() = repository.refresh()
    suspend fun send(kind: CareKind, message: String?) =
        repository.send(kind, message?.trim()?.takeIf(String::isNotBlank))
    suspend fun respond(id: String, response: CareResponse) = repository.respond(id, response)
    suspend fun retry(clientRequestId: String) = repository.retry(clientRequestId)
    suspend fun deleteDraft(clientRequestId: String) = repository.deleteDraft(clientRequestId)
}

class PrivacyUseCases(private val repository: PrivacyRepository) {
    suspend fun refresh() = repository.refresh()
    suspend fun pause() = repository.pause()
    suspend fun resume() = repository.resume()
}

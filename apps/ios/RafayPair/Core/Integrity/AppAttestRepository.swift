import Foundation

protocol AppAttestRepository: Sendable {
    func createChallenge(supported: Bool, keyId: String?) async throws -> AppAttestChallenge
    func submitAttestation(
        challenge: AppAttestChallenge,
        keyId: String,
        object: Data
    ) async throws -> AppAttestAssessment
    func submitAssertion(
        challenge: AppAttestChallenge,
        keyId: String,
        object: Data
    ) async throws -> AppAttestAssessment
    func submitUnsupported(challenge: AppAttestChallenge) async throws -> AppAttestAssessment
}

actor RemoteAppAttestRepository: AppAttestRepository {
    private let api: APIClient

    init(api: APIClient) {
        self.api = api
    }

    func createChallenge(supported: Bool, keyId: String?) async throws -> AppAttestChallenge {
        let response: AppAttestChallengeResponse = try await api.authenticated(
            "/v1/integrity/ios/challenges",
            method: .post,
            body: CreateAppAttestChallengeRequest(
                action: "session_start",
                supported: supported,
                keyId: keyId
            )
        )
        guard response.challenge.bindingVersion == "app-attest-sha256-v1" else {
            throw APIError.invalidResponse
        }
        return response.challenge
    }

    func submitAttestation(
        challenge: AppAttestChallenge,
        keyId: String,
        object: Data
    ) async throws -> AppAttestAssessment {
        let response: AppAttestAssessmentResponse = try await api.authenticated(
            "/v1/integrity/ios/assessments",
            method: .post,
            body: AppAttestationSubmission(
                challengeId: challenge.id,
                action: challenge.action,
                keyId: keyId,
                attestationObject: object.base64EncodedString()
            )
        )
        return response.assessment
    }

    func submitAssertion(
        challenge: AppAttestChallenge,
        keyId: String,
        object: Data
    ) async throws -> AppAttestAssessment {
        let response: AppAttestAssessmentResponse = try await api.authenticated(
            "/v1/integrity/ios/assessments",
            method: .post,
            body: AppAssertionSubmission(
                challengeId: challenge.id,
                action: challenge.action,
                keyId: keyId,
                assertionObject: object.base64EncodedString()
            )
        )
        return response.assessment
    }

    func submitUnsupported(challenge: AppAttestChallenge) async throws -> AppAttestAssessment {
        let response: AppAttestAssessmentResponse = try await api.authenticated(
            "/v1/integrity/ios/assessments",
            method: .post,
            body: UnsupportedAppAttestSubmission(
                challengeId: challenge.id,
                action: challenge.action
            )
        )
        return response.assessment
    }
}

import Foundation

enum AppAttestProofMode: String, Codable, Sendable {
    case attestation
    case assertion
    case unsupported
}

enum AppAttestRiskSignal: String, Codable, Sendable {
    case lowRisk = "low_risk"
    case elevatedRisk = "elevated_risk"
    case invalidBinding = "invalid_binding"
}

struct CreateAppAttestChallengeRequest: Encodable, Sendable {
    let action: String
    let supported: Bool
    let keyId: String?
}

struct AppAttestChallenge: Decodable, Sendable {
    let id: UUID
    let action: String
    let mode: AppAttestProofMode
    let bindingVersion: String
    let clientData: String
    let expiresAt: Date
}

struct AppAttestChallengeResponse: Decodable, Sendable {
    let challenge: AppAttestChallenge
}

struct AppAttestationSubmission: Encodable, Sendable {
    let challengeId: UUID
    let action: String
    let mode = AppAttestProofMode.attestation
    let keyId: String
    let attestationObject: String
}

struct AppAssertionSubmission: Encodable, Sendable {
    let challengeId: UUID
    let action: String
    let mode = AppAttestProofMode.assertion
    let keyId: String
    let assertionObject: String
}

struct UnsupportedAppAttestSubmission: Encodable, Sendable {
    let challengeId: UUID
    let action: String
    let mode = AppAttestProofMode.unsupported
}

struct AppAttestAssessment: Decodable, Sendable {
    let id: UUID
    let signal: AppAttestRiskSignal
    let evaluatedAt: Date
}

struct AppAttestAssessmentResponse: Decodable, Sendable {
    let assessment: AppAttestAssessment
}

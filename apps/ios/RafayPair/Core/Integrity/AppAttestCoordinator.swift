import CryptoKit
@preconcurrency import DeviceCheck
import Foundation

protocol AppAttestServicing: Sendable {
    var isSupported: Bool { get async }
    func generateKey() async throws -> String
    func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data
    func generateAssertion(_ keyID: String, clientDataHash: Data) async throws -> Data
}

actor SystemAppAttestService: AppAttestServicing {
    private let service: DCAppAttestService

    init(service: DCAppAttestService = .shared) {
        self.service = service
    }

    var isSupported: Bool { service.isSupported }

    func generateKey() async throws -> String {
        try await service.generateKey()
    }

    func attestKey(_ keyID: String, clientDataHash: Data) async throws -> Data {
        try await service.attestKey(keyID, clientDataHash: clientDataHash)
    }

    func generateAssertion(_ keyID: String, clientDataHash: Data) async throws -> Data {
        try await service.generateAssertion(keyID, clientDataHash: clientDataHash)
    }
}

enum AppAttestActivationResult: Equatable, Sendable {
    case recorded(AppAttestRiskSignal)
    case deferred
}

actor AppAttestCoordinator {
    private let service: any AppAttestServicing
    private let repository: any AppAttestRepository
    private let keyStore: any AppAttestKeyIDStoring
    private let minimumAssessmentInterval: TimeInterval
    private var activeUsers = Set<UUID>()
    private var lastAttemptAt: [UUID: Date] = [:]

    init(
        service: any AppAttestServicing,
        repository: any AppAttestRepository,
        keyStore: any AppAttestKeyIDStoring,
        minimumAssessmentInterval: TimeInterval = 15 * 60
    ) {
        self.service = service
        self.repository = repository
        self.keyStore = keyStore
        self.minimumAssessmentInterval = minimumAssessmentInterval
    }

    /// Records a risk signal without changing authentication or feature authorization.
    /// Network, DeviceCheck, and verification failures therefore never sign a user out.
    func activate(for userID: UUID, now: Date = Date()) async -> AppAttestActivationResult {
        guard !activeUsers.contains(userID) else { return .deferred }
        if let previous = lastAttemptAt[userID], now.timeIntervalSince(previous) < minimumAssessmentInterval {
            return .deferred
        }
        activeUsers.insert(userID)
        lastAttemptAt[userID] = now
        defer { activeUsers.remove(userID) }

        do {
            guard await service.isSupported else {
                let challenge = try await repository.createChallenge(supported: false, keyId: nil)
                guard challenge.mode == .unsupported else { throw APIError.invalidResponse }
                let assessment = try await repository.submitUnsupported(challenge: challenge)
                return .recorded(assessment.signal)
            }

            let keyID = try await loadOrGenerateKey(for: userID)
            let challenge = try await repository.createChallenge(supported: true, keyId: keyID)
            let clientData = try decodeCanonicalBase64URL(challenge.clientData)
            let clientDataHash = Data(SHA256.hash(data: clientData))
            switch challenge.mode {
            case .attestation:
                let object: Data
                do {
                    object = try await service.attestKey(keyID, clientDataHash: clientDataHash)
                } catch {
                    if !Self.isServerUnavailable(error) {
                        try? await keyStore.remove(for: userID)
                    }
                    throw error
                }
                let assessment = try await repository.submitAttestation(
                    challenge: challenge,
                    keyId: keyID,
                    object: object
                )
                if assessment.signal == .invalidBinding {
                    try? await keyStore.remove(for: userID)
                }
                return .recorded(assessment.signal)
            case .assertion:
                let object: Data
                do {
                    object = try await service.generateAssertion(
                        keyID,
                        clientDataHash: clientDataHash
                    )
                } catch {
                    if Self.isInvalidKey(error) {
                        try? await keyStore.remove(for: userID)
                    }
                    throw error
                }
                let assessment = try await repository.submitAssertion(
                    challenge: challenge,
                    keyId: keyID,
                    object: object
                )
                if assessment.signal == .invalidBinding {
                    try? await keyStore.remove(for: userID)
                }
                return .recorded(assessment.signal)
            case .unsupported:
                throw APIError.invalidResponse
            }
        } catch {
            return .deferred
        }
    }

    private func loadOrGenerateKey(for userID: UUID) async throws -> String {
        if let stored = try await keyStore.load(for: userID) { return stored }
        let generated = try await service.generateKey()
        try await keyStore.save(generated, for: userID)
        return generated
    }

    private func decodeCanonicalBase64URL(_ value: String) throws -> Data {
        guard
            !value.isEmpty,
            value.count <= 1_024,
            value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
        else { throw APIError.invalidResponse }
        var encoded = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        guard let decoded = Data(base64Encoded: encoded), decoded.base64URLEncodedString == value else {
            throw APIError.invalidResponse
        }
        return decoded
    }

    private static func isServerUnavailable(_ error: Error) -> Bool {
        let value = error as NSError
        return value.domain == DCError.errorDomain && value.code == DCError.serverUnavailable.rawValue
    }

    private static func isInvalidKey(_ error: Error) -> Bool {
        let value = error as NSError
        return value.domain == DCError.errorDomain && value.code == DCError.invalidKey.rawValue
    }
}

private extension Data {
    var base64URLEncodedString: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

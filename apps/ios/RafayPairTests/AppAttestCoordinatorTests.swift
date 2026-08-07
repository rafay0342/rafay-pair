import CryptoKit
import DeviceCheck
import Foundation
import XCTest

@testable import RafayPair

final class AppAttestCoordinatorTests: XCTestCase {
    func testUnsupportedDeviceRecordsElevatedRiskWithoutGeneratingAKey() async throws {
        let service = TestAppAttestService(supported: false)
        let repository = TestAppAttestRepository(mode: .unsupported)
        let keyStore = TestAppAttestKeyStore()
        let coordinator = AppAttestCoordinator(
            service: service,
            repository: repository,
            keyStore: keyStore,
            minimumAssessmentInterval: 0
        )

        let result = await coordinator.activate(for: UUID())
        let modes = await repository.submittedModes()
        let generated = await service.generatedKeyCount()

        XCTAssertEqual(result, .recorded(.elevatedRisk))
        XCTAssertEqual(modes, [.unsupported])
        XCTAssertEqual(generated, 0)
    }

    func testAttestationHashesServerClientDataAndPersistsPerUserKey() async throws {
        let userID = UUID()
        let clientData = Data("server-owned-client-data".utf8)
        let service = TestAppAttestService(supported: true)
        let repository = TestAppAttestRepository(mode: .attestation, clientData: clientData)
        let keyStore = TestAppAttestKeyStore()
        let coordinator = AppAttestCoordinator(
            service: service,
            repository: repository,
            keyStore: keyStore,
            minimumAssessmentInterval: 0
        )

        let result = await coordinator.activate(for: userID)
        let storedKey = await keyStore.load(for: userID)
        let modes = await repository.submittedModes()
        let capturedHash = await service.lastClientDataHash()

        XCTAssertEqual(result, .recorded(.lowRisk))
        XCTAssertEqual(storedKey, TestAppAttestService.keyID)
        XCTAssertEqual(modes, [.attestation])
        XCTAssertEqual(
            capturedHash,
            Data(SHA256.hash(data: clientData))
        )
    }

    func testAssertionReusesStoredKeyAndDoesNotGenerateAnother() async throws {
        let userID = UUID()
        let service = TestAppAttestService(supported: true)
        let repository = TestAppAttestRepository(mode: .assertion)
        let keyStore = TestAppAttestKeyStore()
        await keyStore.save(TestAppAttestService.keyID, for: userID)
        let coordinator = AppAttestCoordinator(
            service: service,
            repository: repository,
            keyStore: keyStore,
            minimumAssessmentInterval: 0
        )

        let result = await coordinator.activate(for: userID)
        let modes = await repository.submittedModes()
        let generated = await service.generatedKeyCount()

        XCTAssertEqual(result, .recorded(.lowRisk))
        XCTAssertEqual(modes, [.assertion])
        XCTAssertEqual(generated, 0)
    }

    func testServerUnavailableKeepsKeyButOtherAttestationErrorsDiscardIt() async throws {
        let retainedUser = UUID()
        let retainedStore = TestAppAttestKeyStore()
        let unavailable = TestAppAttestService(supported: true, failure: .serverUnavailable)
        let retainedCoordinator = AppAttestCoordinator(
            service: unavailable,
            repository: TestAppAttestRepository(mode: .attestation),
            keyStore: retainedStore,
            minimumAssessmentInterval: 0
        )
        let retainedResult = await retainedCoordinator.activate(for: retainedUser)
        let retainedKey = await retainedStore.load(for: retainedUser)
        XCTAssertEqual(retainedResult, .deferred)
        XCTAssertEqual(retainedKey, TestAppAttestService.keyID)

        let discardedUser = UUID()
        let discardedStore = TestAppAttestKeyStore()
        let fatal = TestAppAttestService(supported: true, failure: .fatal)
        let discardedCoordinator = AppAttestCoordinator(
            service: fatal,
            repository: TestAppAttestRepository(mode: .attestation),
            keyStore: discardedStore,
            minimumAssessmentInterval: 0
        )
        let discardedResult = await discardedCoordinator.activate(for: discardedUser)
        let discardedKey = await discardedStore.load(for: discardedUser)
        XCTAssertEqual(discardedResult, .deferred)
        XCTAssertNil(discardedKey)
    }

    func testForegroundCooldownAvoidsChallengeFlooding() async {
        let repository = TestAppAttestRepository(mode: .unsupported)
        let coordinator = AppAttestCoordinator(
            service: TestAppAttestService(supported: false),
            repository: repository,
            keyStore: TestAppAttestKeyStore(),
            minimumAssessmentInterval: 900
        )
        let userID = UUID()
        let now = Date(timeIntervalSince1970: 1_000)

        let first = await coordinator.activate(for: userID, now: now)
        let second = await coordinator.activate(for: userID, now: now.addingTimeInterval(10))
        let challengeCount = await repository.challengeCount()
        XCTAssertEqual(first, .recorded(.elevatedRisk))
        XCTAssertEqual(second, .deferred)
        XCTAssertEqual(challengeCount, 1)
    }

    func testInvalidBackendBindingDiscardsTheLocalKeyWithoutBlockingTheSession() async {
        let userID = UUID()
        let keyStore = TestAppAttestKeyStore()
        let coordinator = AppAttestCoordinator(
            service: TestAppAttestService(supported: true),
            repository: TestAppAttestRepository(
                mode: .attestation,
                proofSignal: .invalidBinding
            ),
            keyStore: keyStore,
            minimumAssessmentInterval: 0
        )

        let result = await coordinator.activate(for: userID)
        let stored = await keyStore.load(for: userID)

        XCTAssertEqual(result, .recorded(.invalidBinding))
        XCTAssertNil(stored)
    }
}

private actor TestAppAttestKeyStore: AppAttestKeyIDStoring {
    private var values: [UUID: String] = [:]

    func load(for userID: UUID) -> String? { values[userID] }
    func save(_ keyID: String, for userID: UUID) { values[userID] = keyID }
    func remove(for userID: UUID) { values.removeValue(forKey: userID) }
}

private actor TestAppAttestService: AppAttestServicing {
    enum Failure: Sendable {
        case serverUnavailable
        case fatal
    }

    static let keyID = Data(repeating: 9, count: 32).base64EncodedString()
    private let supported: Bool
    private let failure: Failure?
    private var generated = 0
    private var capturedHash: Data?

    init(supported: Bool, failure: Failure? = nil) {
        self.supported = supported
        self.failure = failure
    }

    var isSupported: Bool { supported }

    func generateKey() -> String {
        generated += 1
        return Self.keyID
    }

    func attestKey(_ keyID: String, clientDataHash: Data) throws -> Data {
        capturedHash = clientDataHash
        if failure == .serverUnavailable {
            throw NSError(
                domain: DCError.errorDomain,
                code: DCError.serverUnavailable.rawValue
            )
        }
        if failure == .fatal { throw TestFailure.attestation }
        return Data([0xa1, 0x01])
    }

    func generateAssertion(_ keyID: String, clientDataHash: Data) throws -> Data {
        capturedHash = clientDataHash
        return Data([0xa2, 0x02])
    }

    func generatedKeyCount() -> Int { generated }
    func lastClientDataHash() -> Data? { capturedHash }
}

private actor TestAppAttestRepository: AppAttestRepository {
    private let mode: AppAttestProofMode
    private let clientData: Data
    private let proofSignal: AppAttestRiskSignal
    private var modes: [AppAttestProofMode] = []
    private var challenges = 0

    init(
        mode: AppAttestProofMode,
        clientData: Data = Data("canonical".utf8),
        proofSignal: AppAttestRiskSignal = .lowRisk
    ) {
        self.mode = mode
        self.clientData = clientData
        self.proofSignal = proofSignal
    }

    func createChallenge(supported: Bool, keyId: String?) -> AppAttestChallenge {
        challenges += 1
        return AppAttestChallenge(
            id: UUID(),
            action: "session_start",
            mode: mode,
            bindingVersion: "app-attest-sha256-v1",
            clientData: clientData.base64URL,
            expiresAt: Date().addingTimeInterval(120)
        )
    }

    func submitAttestation(
        challenge: AppAttestChallenge,
        keyId: String,
        object: Data
    ) -> AppAttestAssessment {
        modes.append(.attestation)
        return assessment(signal: proofSignal)
    }

    func submitAssertion(
        challenge: AppAttestChallenge,
        keyId: String,
        object: Data
    ) -> AppAttestAssessment {
        modes.append(.assertion)
        return assessment(signal: proofSignal)
    }

    func submitUnsupported(challenge: AppAttestChallenge) -> AppAttestAssessment {
        modes.append(.unsupported)
        return assessment(signal: .elevatedRisk)
    }

    func submittedModes() -> [AppAttestProofMode] { modes }
    func challengeCount() -> Int { challenges }

    private func assessment(signal: AppAttestRiskSignal) -> AppAttestAssessment {
        AppAttestAssessment(id: UUID(), signal: signal, evaluatedAt: Date())
    }
}

private enum TestFailure: Error {
    case attestation
}

private extension Data {
    var base64URL: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

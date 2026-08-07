import SwiftData
import XCTest

@testable import RafayPair

@MainActor
final class PrivacyAndCareStateTests: XCTestCase {
    func testPendingPausePersistsPerAccountAndRetriesUsingSamePairScope() async throws {
        let userID = UUID()
        let pairID = UUID()
        let defaults = try makeDefaults()
        let repository = PrivacyRepositoryStub(userID: userID, pairID: pairID, pauseFailures: 1)
        let store = PrivacyStore(repository: repository, defaults: defaults)
        store.bind(userID: userID, pairID: pairID)
        await store.load()

        await store.pause()

        XCTAssertTrue(store.state.paused)
        XCTAssertTrue(store.serverSyncPending)
        XCTAssertFalse(store.isSharingAllowed)

        let restored = PrivacyStore(repository: repository, defaults: defaults)
        restored.bind(userID: userID, pairID: pairID)
        XCTAssertTrue(restored.state.paused)
        XCTAssertTrue(restored.serverSyncPending)

        await restored.retryPendingPause()

        XCTAssertTrue(restored.state.paused)
        XCTAssertFalse(restored.serverSyncPending)
        XCTAssertFalse(restored.isSharingAllowed)

        let otherAccount = PrivacyStore(repository: repository, defaults: defaults)
        otherAccount.bind(userID: UUID(), pairID: UUID())
        XCTAssertFalse(otherAccount.state.paused)
        XCTAssertFalse(otherAccount.serverSyncPending)
    }

    func testResumeNeverClearsLocalProtectionBeforeServerConfirmation() async throws {
        let userID = UUID()
        let pairID = UUID()
        let defaults = try makeDefaults()
        let repository = PrivacyRepositoryStub(
            userID: userID,
            pairID: pairID,
            initiallyPaused: true,
            resumeFailures: 1
        )
        let store = PrivacyStore(repository: repository, defaults: defaults)
        store.bind(userID: userID, pairID: pairID)
        await store.load()

        await store.resume()

        XCTAssertTrue(store.state.paused)
        XCTAssertFalse(store.isSharingAllowed)
        let restored = PrivacyStore(repository: repository, defaults: defaults)
        restored.bind(userID: userID, pairID: pairID)
        XCTAssertTrue(restored.state.paused)
    }

    func testOfflineCareQueueReusesIdempotencyKeyAndDeletesAfterAuthorizedSync() async throws {
        let userID = UUID()
        let partnerID = UUID()
        let pairID = UUID()
        let privacyRepository = PrivacyRepositoryStub(userID: userID, pairID: pairID)
        let privacy = PrivacyStore(repository: privacyRepository, defaults: try makeDefaults())
        privacy.bind(userID: userID, pairID: pairID)
        await privacy.load()
        XCTAssertTrue(privacy.isSharingAllowed)

        let pair = activePair(id: pairID, userID: userID, partnerID: partnerID)
        let pairRepository = PairRepositoryStub(pair: pair)
        let careRepository = CareRepositoryStub(
            pairID: pairID,
            senderID: userID,
            recipientID: partnerID,
            sendFailures: 1
        )
        let store = CareStore(repository: careRepository, pairRepository: pairRepository)
        store.bindAccount(userID)

        let container = try ModelContainer(
            for: CareDraft.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let context = ModelContext(container)
        let draft = CareDraft(
            ownerUserID: userID,
            pairID: pairID,
            kind: .help,
            note: "Please call"
        )
        context.insert(draft)
        try context.save()

        let outcome = await store.send(draft: draft, privacyStore: privacy, modelContext: context)

        XCTAssertEqual(outcome, .queued)
        XCTAssertEqual(draft.deliveryState, .queued)
        let idempotencyKey = draft.id
        draft.lastAttemptAt = .distantPast
        await store.syncQueued(
            drafts: [draft],
            userID: userID,
            pairID: pairID,
            privacyStore: privacy,
            modelContext: context
        )

        XCTAssertEqual(try context.fetchCount(FetchDescriptor<CareDraft>()), 0)
        XCTAssertEqual(store.requests.count, 1)
        let sentKeys = await careRepository.sentKeys()
        let validationCount = await pairRepository.validationCount()
        XCTAssertEqual(sentKeys, [idempotencyKey, idempotencyKey])
        XCTAssertGreaterThanOrEqual(validationCount, 2)
    }

    func testDraftCleanupNeverRetainsAnotherAccountOrPair() throws {
        let owner = UUID()
        let retainedPair = UUID()
        let otherOwner = UUID()
        let container = try ModelContainer(
            for: CareDraft.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let context = ModelContext(container)
        context.insert(CareDraft(ownerUserID: owner, pairID: retainedPair))
        context.insert(CareDraft(ownerUserID: owner, pairID: UUID()))
        context.insert(CareDraft(ownerUserID: otherOwner, pairID: UUID()))
        try context.save()

        try CareDraftPersistence.clearAccounts(except: owner, in: context)
        try CareDraftPersistence.clearOutsidePair(
            ownerUserID: owner,
            retainedPairID: retainedPair,
            in: context
        )

        let remaining = try context.fetch(FetchDescriptor<CareDraft>())
        XCTAssertEqual(remaining.count, 1)
        XCTAssertEqual(remaining.first?.ownerUserID, owner)
        XCTAssertEqual(remaining.first?.pairID, retainedPair)
    }

    func testQueuedCareStaysQueuedWhenPairRevalidationIsTemporarilyUnavailable() async throws {
        let userID = UUID()
        let partnerID = UUID()
        let pairID = UUID()
        let privacyRepository = PrivacyRepositoryStub(userID: userID, pairID: pairID)
        let privacy = PrivacyStore(repository: privacyRepository, defaults: try makeDefaults())
        privacy.bind(userID: userID, pairID: pairID)
        await privacy.load()

        let pairRepository = PairRepositoryStub(
            pair: activePair(id: pairID, userID: userID, partnerID: partnerID),
            currentFailures: 1
        )
        let careRepository = CareRepositoryStub(
            pairID: pairID,
            senderID: userID,
            recipientID: partnerID,
            sendFailures: 0
        )
        let store = CareStore(repository: careRepository, pairRepository: pairRepository)
        store.bindAccount(userID)
        let container = try ModelContainer(
            for: CareDraft.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let context = ModelContext(container)
        let draft = CareDraft(ownerUserID: userID, pairID: pairID)
        draft.recordQueuedFailure("offline")
        draft.lastAttemptAt = .distantPast
        context.insert(draft)
        try context.save()

        await store.syncQueued(
            drafts: [draft],
            userID: userID,
            pairID: pairID,
            privacyStore: privacy,
            modelContext: context
        )

        XCTAssertEqual(draft.deliveryState, .queued)
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<CareDraft>()), 1)
        let sentKeys = await careRepository.sentKeys()
        XCTAssertTrue(sentKeys.isEmpty)
    }

    private func makeDefaults() throws -> UserDefaults {
        let suite = "PrivacyAndCareStateTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        return defaults
    }

    private func activePair(id: UUID, userID: UUID, partnerID: UUID) -> PairSummary {
        PairSummary(
            id: id,
            status: .active,
            members: [
                PairMember(userId: userID, displayName: "Current", joinedAt: Date()),
                PairMember(userId: partnerID, displayName: "Partner", joinedAt: Date()),
            ],
            joinCode: nil,
            createdAt: Date()
        )
    }
}

private actor PrivacyRepositoryStub: PrivacyRepository {
    private let userID: UUID
    private let pairID: UUID
    private var paused: Bool
    private var pauseFailures: Int
    private var resumeFailures: Int

    init(
        userID: UUID,
        pairID: UUID,
        initiallyPaused: Bool = false,
        pauseFailures: Int = 0,
        resumeFailures: Int = 0
    ) {
        self.userID = userID
        self.pairID = pairID
        paused = initiallyPaused
        self.pauseFailures = pauseFailures
        self.resumeFailures = resumeFailures
    }

    func current() async throws -> PrivacyState { state() }

    func pause() async throws -> PrivacyState {
        if pauseFailures > 0 {
            pauseFailures -= 1
            throw APIError.transport("offline")
        }
        paused = true
        return state()
    }

    func resume() async throws -> PrivacyState {
        if resumeFailures > 0 {
            resumeFailures -= 1
            throw APIError.transport("offline")
        }
        paused = false
        return state()
    }

    private func state() -> PrivacyState {
        PrivacyState(
            pairId: pairID,
            userId: userID,
            paused: paused,
            pausedAt: paused ? Date() : nil,
            updatedAt: Date()
        )
    }
}

private actor PairRepositoryStub: PairRepository {
    private let pair: PairSummary?
    private var currentFailures: Int
    private var validations = 0

    init(pair: PairSummary?, currentFailures: Int = 0) {
        self.pair = pair
        self.currentFailures = currentFailures
    }

    func current() async throws -> PairSummary? {
        validations += 1
        if currentFailures > 0 {
            currentFailures -= 1
            throw APIError.transport("offline")
        }
        return pair
    }

    func create() async throws -> PairSummary { throw APIError.invalidResponse }
    func join(code: String) async throws -> PairSummary { throw APIError.invalidResponse }
    func disconnect() async throws {}
    func validationCount() -> Int { validations }
}

private actor CareRepositoryStub: CareRepository {
    private let pairID: UUID
    private let senderID: UUID
    private let recipientID: UUID
    private var failuresRemaining: Int
    private var keys: [UUID] = []

    init(pairID: UUID, senderID: UUID, recipientID: UUID, sendFailures: Int) {
        self.pairID = pairID
        self.senderID = senderID
        self.recipientID = recipientID
        failuresRemaining = sendFailures
    }

    func list() async throws -> [CareRequest] { [] }

    func send(kind: CareRequestKind, note: String?, idempotencyKey: UUID) async throws -> CareRequest {
        keys.append(idempotencyKey)
        if failuresRemaining > 0 {
            failuresRemaining -= 1
            throw APIError.transport("offline")
        }
        return CareRequest(
            id: UUID(),
            clientRequestId: idempotencyKey,
            pairId: pairID,
            senderUserId: senderID,
            recipientUserId: recipientID,
            kind: kind,
            message: note,
            status: .pending,
            createdAt: Date(),
            respondedAt: nil
        )
    }

    func respond(id: UUID, response: CareRequestStatus) async throws -> CareRequest {
        throw APIError.invalidResponse
    }

    func sentKeys() -> [UUID] { keys }
}

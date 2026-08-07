import Foundation
import Observation
import SwiftData

enum CareSendOutcome: Equatable {
    case sent
    case queued
    case failed
}

@MainActor
@Observable
final class CareStore {
    private let repository: any CareRepository
    private let pairRepository: any PairRepository
    private var accountID: UUID?
    private(set) var requests: [CareRequest] = []
    private(set) var isLoading = false
    private(set) var isSending = false
    private(set) var isSyncingQueue = false
    private(set) var respondingIDs: Set<UUID> = []
    var errorMessage: String?

    init(repository: any CareRepository, pairRepository: any PairRepository) {
        self.repository = repository
        self.pairRepository = pairRepository
    }

    func bindAccount(_ userID: UUID) {
        guard accountID != userID else { return }
        clear()
        accountID = userID
    }

    func load() async {
        guard let expectedAccount = accountID, !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let loaded = try await repository.list().sorted { $0.createdAt > $1.createdAt }
            guard accountID == expectedAccount else { return }
            requests = loaded
        } catch {
            guard accountID == expectedAccount else { return }
            errorMessage = error.localizedDescription
        }
    }

    func send(
        draft: CareDraft,
        privacyStore: PrivacyStore,
        modelContext: ModelContext
    ) async -> CareSendOutcome {
        guard
            let expectedAccount = accountID,
            draft.ownerUserID == expectedAccount,
            let expectedPair = draft.pairID,
            privacyStore.isSharingAllowed,
            !isSending
        else {
            errorMessage = "Care requests cannot be sent while privacy sharing is paused or unavailable."
            return .failed
        }
        isSending = true
        errorMessage = nil
        defer { isSending = false }
        do {
            try await validateActivePair(expectedPair)
            guard privacyStore.isSharingAllowed else {
                throw CareQueueValidationError.privacyPaused
            }
            let request = try await repository.send(
                kind: draft.kind,
                note: cleanedNote(draft.note),
                idempotencyKey: draft.id
            )
            guard accountID == expectedAccount, privacyStore.isSharingAllowed else { return .failed }
            insertIfNew(request)
            modelContext.delete(draft)
            try modelContext.save()
            return .sent
        } catch  where isRetryableCareError(error) {
            guard accountID == expectedAccount else { return .failed }
            guard privacyStore.isSharingAllowed else {
                draft.requireReview("Privacy sharing was paused. Review this request before sending it again.")
                try? modelContext.save()
                errorMessage = "Privacy sharing was paused before the request could be queued."
                return .failed
            }
            draft.recordQueuedFailure(error.localizedDescription)
            do {
                try modelContext.save()
                errorMessage = "Saved securely. RafayPair will retry after reconnecting and rechecking the pair."
                return .queued
            } catch {
                errorMessage = "The offline request could not be saved securely. Please try again while connected."
                return .failed
            }
        } catch {
            guard accountID == expectedAccount else { return .failed }
            draft.requireReview(error.localizedDescription)
            try? modelContext.save()
            errorMessage = error.localizedDescription
            return .failed
        }
    }

    func syncQueued(
        drafts: [CareDraft],
        userID: UUID,
        pairID: UUID,
        privacyStore: PrivacyStore,
        modelContext: ModelContext
    ) async {
        guard accountID == userID, privacyStore.isSharingAllowed, !isSyncingQueue else { return }
        let queued =
            drafts
            .filter {
                $0.ownerUserID == userID && $0.pairID == pairID && $0.deliveryState == .queued
                    && $0.isEligibleForRetry
            }
            .sorted { $0.createdAt < $1.createdAt }
        guard !queued.isEmpty else { return }

        isSyncingQueue = true
        defer { isSyncingQueue = false }
        do {
            try await validateActivePair(pairID)
        } catch  where isRetryableCareError(error) {
            for draft in queued {
                draft.recordQueuedFailure(error.localizedDescription)
            }
            try? modelContext.save()
            return
        } catch {
            for draft in queued {
                draft.requireReview("The pair changed. Review this request before sending it again.")
            }
            try? modelContext.save()
            return
        }

        for draft in queued {
            guard accountID == userID, privacyStore.isSharingAllowed else { return }
            do {
                // The existing idempotency key is always reused. The API atomically
                // revalidates the recipient's current directional consent and both
                // privacy states immediately before creating the request.
                let request = try await repository.send(
                    kind: draft.kind,
                    note: cleanedNote(draft.note),
                    idempotencyKey: draft.id
                )
                guard accountID == userID, privacyStore.isSharingAllowed else { return }
                insertIfNew(request)
                modelContext.delete(draft)
                try modelContext.save()
            } catch  where isRetryableCareError(error) {
                draft.recordQueuedFailure(error.localizedDescription)
                try? modelContext.save()
                return
            } catch {
                draft.requireReview(error.localizedDescription)
                try? modelContext.save()
            }
        }
    }

    func respond(
        to request: CareRequest,
        with response: CareRequestStatus,
        sharingAllowed: Bool
    ) async {
        guard sharingAllowed else {
            errorMessage = "Care responses are unavailable while privacy sharing is paused."
            return
        }
        guard let expectedAccount = accountID, !respondingIDs.contains(request.id) else { return }
        respondingIDs.insert(request.id)
        errorMessage = nil
        defer { respondingIDs.remove(request.id) }
        do {
            let updated = try await repository.respond(id: request.id, response: response)
            guard accountID == expectedAccount else { return }
            if let index = requests.firstIndex(where: { $0.id == updated.id }) {
                requests[index] = updated
            }
        } catch {
            guard accountID == expectedAccount else { return }
            errorMessage = error.localizedDescription
        }
    }

    func clear() {
        accountID = nil
        requests = []
        isLoading = false
        isSending = false
        isSyncingQueue = false
        respondingIDs = []
        errorMessage = nil
    }

    private func validateActivePair(_ expectedPairID: UUID) async throws {
        guard let pair = try await pairRepository.current(), pair.id == expectedPairID, pair.status == .active else {
            throw CareQueueValidationError.pairChanged
        }
    }

    private func cleanedNote(_ note: String) -> String? {
        let cleaned = note.trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? nil : cleaned
    }

    private func insertIfNew(_ request: CareRequest) {
        guard !requests.contains(where: { $0.id == request.id }) else { return }
        requests.insert(request, at: 0)
    }

    private func isRetryableCareError(_ error: Error) -> Bool {
        switch error {
        case APIError.transport:
            true
        case APIError.server(let problem):
            problem.status == 429 || problem.status >= 500
        default:
            false
        }
    }
}

private enum CareQueueValidationError: LocalizedError {
    case pairChanged
    case privacyPaused

    var errorDescription: String? {
        switch self {
        case .pairChanged:
            "The active pair changed. Review the request before sending it again."
        case .privacyPaused:
            "Privacy sharing is paused."
        }
    }
}

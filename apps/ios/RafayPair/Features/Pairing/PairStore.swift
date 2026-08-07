import Foundation
import Observation

@MainActor
@Observable
final class PairStore {
    private let repository: any PairRepository
    private var accountID: UUID?
    private(set) var pair: PairSummary?
    private(set) var hasLoaded = false
    private(set) var isLoading = false
    private(set) var isMutating = false
    var errorMessage: String?

    init(repository: any PairRepository) {
        self.repository = repository
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
            let loaded = try await repository.current()
            guard accountID == expectedAccount else { return }
            pair = loaded
            hasLoaded = true
        } catch {
            guard accountID == expectedAccount else { return }
            errorMessage = error.localizedDescription
        }
    }

    func create() async {
        await mutate { try await repository.create() }
    }

    func join(code: String) async {
        let normalized = code.uppercased().filter { $0.isLetter || $0.isNumber }
        guard normalized.count >= 6 else {
            errorMessage = "Enter the complete pairing code."
            return
        }
        await mutate { try await repository.join(code: normalized) }
    }

    func disconnect() async throws {
        guard let expectedAccount = accountID, !isMutating else { return }
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }
        do {
            try await repository.disconnect()
            guard accountID == expectedAccount else { return }
            pair = nil
            hasLoaded = true
        } catch {
            guard accountID == expectedAccount else { return }
            errorMessage = error.localizedDescription
            throw error
        }
    }

    func clearAfterRemoteDisconnect() {
        pair = nil
        hasLoaded = true
    }

    func clear() {
        accountID = nil
        pair = nil
        hasLoaded = false
        isLoading = false
        isMutating = false
        errorMessage = nil
    }

    private func mutate(_ operation: () async throws -> PairSummary) async {
        guard let expectedAccount = accountID, !isMutating else { return }
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }
        do {
            let updated = try await operation()
            guard accountID == expectedAccount else { return }
            pair = updated
            hasLoaded = true
        } catch {
            guard accountID == expectedAccount else { return }
            errorMessage = error.localizedDescription
        }
    }
}

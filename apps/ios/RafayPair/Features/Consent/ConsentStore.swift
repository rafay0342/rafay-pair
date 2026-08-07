import Foundation
import Observation

@MainActor
@Observable
final class ConsentStore {
    private let repository: any ConsentRepository
    private var accountID: UUID?
    private(set) var grants: [ConsentScope: ConsentGrant] = [:]
    private(set) var updatingScopes: Set<ConsentScope> = []
    private(set) var isLoading = false
    var errorMessage: String?

    init(repository: any ConsentRepository) {
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
            let values = try await repository.list()
            guard accountID == expectedAccount else { return }
            grants = Dictionary(uniqueKeysWithValues: values.map { ($0.scope, $0) })
        } catch {
            guard accountID == expectedAccount else { return }
            errorMessage = error.localizedDescription
        }
    }

    func isEnabled(_ scope: ConsentScope) -> Bool {
        grants[scope]?.enabled ?? false
    }

    func set(_ scope: ConsentScope, enabled: Bool) async {
        guard let expectedAccount = accountID, !updatingScopes.contains(scope) else { return }
        updatingScopes.insert(scope)
        errorMessage = nil
        defer { updatingScopes.remove(scope) }

        do {
            let updated = try await repository.update(scope: scope, enabled: enabled)
            guard accountID == expectedAccount else { return }
            grants[scope] = updated
        } catch {
            guard accountID == expectedAccount else { return }
            errorMessage = error.localizedDescription
            await load()
        }
    }

    func clear() {
        accountID = nil
        grants = [:]
        updatingScopes = []
        isLoading = false
        errorMessage = nil
    }
}

import Foundation
import Observation

@MainActor
@Observable
final class SessionStore {
    enum State: Equatable {
        case restoring
        case signedOut
        case signedIn(User)
    }

    private let repository: any AuthRepository
    private(set) var state: State = .restoring
    private(set) var isSubmitting = false
    var errorMessage: String?

    var accountID: UUID? {
        guard case .signedIn(let user) = state else { return nil }
        return user.id
    }

    init(repository: any AuthRepository) {
        self.repository = repository
    }

    func restore() async {
        state = .restoring
        do {
            state = .signedIn(try await repository.restoreSession())
        } catch {
            state = .signedOut
        }
    }

    func register(email: String, password: String, displayName: String) async {
        guard !isSubmitting else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            let user = try await repository.register(
                email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                password: password,
                displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            state = .signedIn(user)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func login(email: String, password: String) async {
        guard !isSubmitting else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            let user = try await repository.login(
                email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                password: password
            )
            state = .signedIn(user)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func logout() async {
        await repository.logout()
        errorMessage = nil
        isSubmitting = false
        state = .signedOut
    }

    func invalidate() {
        errorMessage = nil
        isSubmitting = false
        state = .signedOut
    }
}

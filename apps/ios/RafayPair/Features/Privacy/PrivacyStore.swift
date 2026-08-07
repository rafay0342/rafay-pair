import Foundation
import Observation

@MainActor
@Observable
final class PrivacyStore {
    private struct Scope: Equatable {
        let userID: UUID
        let pairID: UUID

        var prefix: String { "privacy.\(userID.uuidString).\(pairID.uuidString)" }
        var pauseIntentKey: String { "\(prefix).pause-intent" }
        var pendingPauseKey: String { "\(prefix).pending-pause" }
    }

    private let repository: any PrivacyRepository
    private let defaults: UserDefaults
    private var accountUserID: UUID?
    private var scope: Scope?
    private(set) var hasLoadedRemoteState = false
    private(set) var state = PrivacyState(
        pairId: nil,
        userId: nil,
        paused: false,
        pausedAt: nil,
        updatedAt: Date()
    )
    private(set) var isMutating = false
    private(set) var serverSyncPending = false
    var errorMessage: String?

    var isSharingAllowed: Bool {
        scope != nil && hasLoadedRemoteState && !state.paused && !serverSyncPending && !isMutating
    }

    init(repository: any PrivacyRepository, defaults: UserDefaults = .standard) {
        self.repository = repository
        self.defaults = defaults
    }

    func bind(userID: UUID, pairID: UUID?) {
        accountUserID = userID
        guard let pairID else {
            resetInMemory(preservingAccount: true)
            return
        }
        let next = Scope(userID: userID, pairID: pairID)
        guard next != scope else { return }
        scope = next
        let pauseIntent = defaults.bool(forKey: next.pauseIntentKey)
        let pendingPause = defaults.bool(forKey: next.pendingPauseKey)
        state = PrivacyState(
            pairId: pairID,
            userId: userID,
            paused: pauseIntent || pendingPause,
            pausedAt: pauseIntent || pendingPause ? Date() : nil,
            updatedAt: Date()
        )
        serverSyncPending = pendingPause
        hasLoadedRemoteState = false
        errorMessage = nil
    }

    func load() async {
        guard let expectedScope = scope else {
            resetInMemory()
            return
        }
        do {
            let remote = try await repository.current()
            guard scope == expectedScope else { return }
            guard remote.userId == expectedScope.userID, remote.pairId == expectedScope.pairID else {
                throw APIError.invalidResponse
            }
            hasLoadedRemoteState = true
            let localPauseRequired =
                defaults.bool(forKey: expectedScope.pauseIntentKey)
                || defaults.bool(forKey: expectedScope.pendingPauseKey)
            if remote.paused {
                state = remote
                persist(pauseIntent: true, pendingPause: false, scope: expectedScope)
                serverSyncPending = false
            } else if localPauseRequired {
                applyLocalPause(scope: expectedScope)
                await retryPendingPause()
            } else {
                state = remote
                persist(pauseIntent: false, pendingPause: false, scope: expectedScope)
                serverSyncPending = false
            }
        } catch {
            guard scope == expectedScope else { return }
            hasLoadedRemoteState = false
            if state.paused { serverSyncPending = true }
            errorMessage = error.localizedDescription
        }
    }

    func pause() async {
        guard let scope else { return }
        // The durable local intent is committed before any suspension point.
        applyLocalPause(scope: scope)
        await retryPendingPause()
    }

    func retryPendingPause() async {
        guard let expectedScope = scope, state.paused, serverSyncPending, !isMutating else { return }
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }
        do {
            let remote = try await repository.pause()
            guard scope == expectedScope else { return }
            guard remote.paused, remote.userId == expectedScope.userID, remote.pairId == expectedScope.pairID else {
                throw APIError.invalidResponse
            }
            state = remote
            hasLoadedRemoteState = true
            serverSyncPending = false
            persist(pauseIntent: true, pendingPause: false, scope: expectedScope)
        } catch {
            guard scope == expectedScope else { return }
            serverSyncPending = true
            persist(pauseIntent: true, pendingPause: true, scope: expectedScope)
            errorMessage = "Sharing is paused on this phone. Server sync will retry when connected."
        }
    }

    func resume() async {
        guard let expectedScope = scope, state.paused, !isMutating else { return }
        guard !serverSyncPending else {
            errorMessage = "Finish syncing the privacy pause before resuming sharing."
            return
        }
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }
        do {
            let remote = try await repository.resume()
            guard scope == expectedScope else { return }
            guard !remote.paused, remote.userId == expectedScope.userID, remote.pairId == expectedScope.pairID else {
                throw APIError.invalidResponse
            }
            // Resume is never optimistic: local protection is cleared only after
            // the server confirms the transition for this exact account and pair.
            state = remote
            hasLoadedRemoteState = true
            persist(pauseIntent: false, pendingPause: false, scope: expectedScope)
        } catch {
            guard scope == expectedScope else { return }
            errorMessage = error.localizedDescription
        }
    }

    func applyRemotePause() {
        guard let scope else { return }
        state = PrivacyState(
            pairId: scope.pairID,
            userId: scope.userID,
            paused: true,
            pausedAt: Date(),
            updatedAt: Date()
        )
        hasLoadedRemoteState = true
        serverSyncPending = false
        persist(pauseIntent: true, pendingPause: false, scope: scope)
    }

    func clearAccountState() {
        if let accountUserID {
            for key in defaults.dictionaryRepresentation().keys
            where key.hasPrefix("privacy.\(accountUserID.uuidString).") {
                defaults.removeObject(forKey: key)
            }
        }
        resetInMemory()
    }

    func discardPersistedState(except userID: UUID?) {
        let retainedPrefix = userID.map { "privacy.\($0.uuidString)." }
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix("privacy.") {
            if let retainedPrefix, key.hasPrefix(retainedPrefix) { continue }
            defaults.removeObject(forKey: key)
        }
    }

    private func applyLocalPause(scope: Scope) {
        state = PrivacyState(
            pairId: scope.pairID,
            userId: scope.userID,
            paused: true,
            pausedAt: state.pausedAt ?? Date(),
            updatedAt: Date()
        )
        hasLoadedRemoteState = true
        serverSyncPending = true
        persist(pauseIntent: true, pendingPause: true, scope: scope)
    }

    private func persist(pauseIntent: Bool, pendingPause: Bool, scope: Scope) {
        defaults.set(pauseIntent, forKey: scope.pauseIntentKey)
        defaults.set(pendingPause, forKey: scope.pendingPauseKey)
    }

    private func resetInMemory(preservingAccount: Bool = false) {
        scope = nil
        if !preservingAccount { accountUserID = nil }
        state = PrivacyState(
            pairId: nil,
            userId: nil,
            paused: false,
            pausedAt: nil,
            updatedAt: Date()
        )
        hasLoadedRemoteState = false
        serverSyncPending = false
        isMutating = false
        errorMessage = nil
    }
}

import Foundation
import Observation

@MainActor
@Observable
final class RealtimeStore {
    private let client: RealtimeClient
    private var eventTask: Task<Void, Never>?
    private var generation = UUID()
    private(set) var connectionState: RealtimeConnectionState = .disconnected

    init(client: RealtimeClient) {
        self.client = client
    }

    func start(
        careStore: CareStore,
        pairStore: PairStore,
        consentStore: ConsentStore,
        privacyStore: PrivacyStore
    ) async {
        guard privacyStore.isSharingAllowed else {
            await stop()
            return
        }
        guard eventTask == nil else { return }
        let currentGeneration = UUID()
        generation = currentGeneration
        let events = await client.events()
        await client.start()
        guard privacyStore.isSharingAllowed, generation == currentGeneration else {
            await client.stop()
            return
        }
        eventTask = Task { @MainActor [weak self] in
            for await event in events {
                guard
                    let self,
                    !Task.isCancelled,
                    self.generation == currentGeneration
                else { break }
                switch event {
                case .careChanged:
                    await careStore.load()
                case .pairDisconnected:
                    pairStore.clearAfterRemoteDisconnect()
                    careStore.clear()
                    consentStore.clear()
                    privacyStore.clearAccountState()
                    await self.stopClientForProtectiveEvent(currentGeneration)
                    return
                case .privacyPaused:
                    privacyStore.applyRemotePause()
                    await self.stopClientForProtectiveEvent(currentGeneration)
                    return
                case .connection(let state):
                    self.connectionState = state
                }
            }
            if self?.generation == currentGeneration {
                self?.eventTask = nil
                self?.connectionState = .disconnected
            }
        }
    }

    func stop() async {
        generation = UUID()
        eventTask?.cancel()
        eventTask = nil
        await client.stop()
        connectionState = .disconnected
    }

    func clearAccountState() async {
        generation = UUID()
        eventTask?.cancel()
        eventTask = nil
        await client.resetAccountState()
        connectionState = .disconnected
    }

    private func stopClientForProtectiveEvent(_ expectedGeneration: UUID) async {
        guard generation == expectedGeneration else { return }
        generation = UUID()
        eventTask = nil
        await client.stop()
        connectionState = .disconnected
    }
}

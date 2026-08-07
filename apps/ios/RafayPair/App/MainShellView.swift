import SwiftData
import SwiftUI

struct MainShellView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase
    @Query private var drafts: [CareDraft]
    let user: User
    @Bindable var sessionStore: SessionStore
    @Bindable var pairStore: PairStore
    @Bindable var consentStore: ConsentStore
    @Bindable var careStore: CareStore
    @Bindable var privacyStore: PrivacyStore
    @Bindable var realtimeStore: RealtimeStore
    @Bindable var connectivity: ConnectivityMonitor
    let notifications: PushNotificationCoordinator
    let appAttest: AppAttestCoordinator
    let together: any TogetherRepository
    let assistant: any AssistantRepository
    let voice: VoiceClient
    let bloodPressure: any BloodPressureRepository

    private var activePairID: UUID? {
        pairStore.pair?.status == .active ? pairStore.pair?.id : nil
    }

    private var realtimeTaskID: String {
        "\(activePairID?.uuidString ?? "none")-\(privacyStore.isSharingAllowed)-\(connectivity.isConnected)"
    }

    private var queuedDrafts: [CareDraft] {
        guard let activePairID else { return [] }
        return drafts.filter {
            $0.ownerUserID == user.id && $0.pairID == activePairID && $0.deliveryState == .queued
        }
    }

    private var queueTaskID: String {
        "\(activePairID?.uuidString ?? "none")-\(connectivity.isConnected)-\(queuedDrafts.count)"
    }

    var body: some View {
        TabView {
            NavigationStack {
                HomeView(
                    user: user,
                    pairStore: pairStore,
                    privacyStore: privacyStore,
                    realtimeStore: realtimeStore
                )
            }
            .tabItem { Label("Home", systemImage: "heart.fill") }

            NavigationStack {
                CareView(
                    user: user,
                    pairStore: pairStore,
                    careStore: careStore,
                    privacyStore: privacyStore
                )
            }
            .tabItem { Label("Care", systemImage: "hands.sparkles.fill") }

            NavigationStack {
                ConsentView(pairStore: pairStore, store: consentStore)
            }
            .tabItem { Label("Sharing", systemImage: "hand.raised.fill") }

            NavigationStack {
                WorkoutView(together: together)
            }
            .tabItem { Label("Move", systemImage: "figure.strengthtraining.functional") }

            NavigationStack {
                VitalsView(bloodPressure: bloodPressure)
            }
            .tabItem { Label("Vitals", systemImage: "heart.text.square.fill") }

            NavigationStack {
                TogetherView(
                    user: user,
                    pairStore: pairStore,
                    privacyStore: privacyStore,
                    together: together,
                    assistant: assistant,
                    voice: voice
                )
            }
            .tabItem { Label("Together", systemImage: "person.2.fill") }

            NavigationStack {
                SettingsView(
                    user: user,
                    sessionStore: sessionStore,
                    pairStore: pairStore,
                    consentStore: consentStore,
                    careStore: careStore,
                    privacyStore: privacyStore
                )
            }
            .tabItem { Label("Settings", systemImage: "gearshape.fill") }
        }
        .task(id: user.id) {
            pairStore.bindAccount(user.id)
            consentStore.bindAccount(user.id)
            careStore.bindAccount(user.id)
            await pairStore.load()
            await activatePairScope()
        }
        .task(id: activePairID) {
            await activatePairScope()
        }
        .task {
            await notifications.activateForSignedInSession()
        }
        .task(id: user.id) {
            _ = await appAttest.activate(for: user.id)
        }
        .task(id: realtimeTaskID) {
            guard activePairID != nil, privacyStore.isSharingAllowed, connectivity.isConnected else {
                await realtimeStore.stop()
                return
            }
            await realtimeStore.start(
                careStore: careStore,
                pairStore: pairStore,
                consentStore: consentStore,
                privacyStore: privacyStore
            )
        }
        .task(id: connectivity.isConnected) {
            guard connectivity.isConnected else {
                await realtimeStore.stop()
                return
            }
            await retryProtectiveAndQueuedWork()
        }
        .task(id: queueTaskID) {
            guard connectivity.isConnected, !queuedDrafts.isEmpty else { return }
            while !Task.isCancelled, connectivity.isConnected, !queuedDrafts.isEmpty {
                await syncQueuedCare()
                if queuedDrafts.isEmpty { return }
                try? await Task.sleep(for: .seconds(5))
            }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task {
                _ = await appAttest.activate(for: user.id)
                await retryProtectiveAndQueuedWork()
            }
        }
        .onDisappear {
            Task { await realtimeStore.stop() }
        }
    }

    private func activatePairScope() async {
        guard pairStore.hasLoaded else { return }
        purgeDraftsOutsideCurrentPair()
        privacyStore.bind(userID: user.id, pairID: activePairID)
        guard activePairID != nil else {
            consentStore.clear()
            careStore.clear()
            consentStore.bindAccount(user.id)
            careStore.bindAccount(user.id)
            return
        }
        consentStore.bindAccount(user.id)
        careStore.bindAccount(user.id)
        await privacyStore.load()
        async let consentLoad: Void = consentStore.load()
        async let careLoad: Void = careStore.load()
        _ = await (consentLoad, careLoad)
        await retryProtectiveAndQueuedWork()
    }

    private func purgeDraftsOutsideCurrentPair() {
        try? CareDraftPersistence.clearOutsidePair(
            ownerUserID: user.id,
            retainedPairID: activePairID,
            in: modelContext
        )
    }

    private func retryProtectiveAndQueuedWork() async {
        guard connectivity.isConnected, activePairID != nil else { return }
        await privacyStore.retryPendingPause()
        await syncQueuedCare()
    }

    private func syncQueuedCare() async {
        guard let activePairID, privacyStore.isSharingAllowed else { return }
        await careStore.syncQueued(
            drafts: queuedDrafts,
            userID: user.id,
            pairID: activePairID,
            privacyStore: privacyStore,
            modelContext: modelContext
        )
    }
}

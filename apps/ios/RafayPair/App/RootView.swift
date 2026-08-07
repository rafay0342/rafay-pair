import SwiftData
import SwiftUI

struct RootView: View {
    @Environment(\.modelContext) private var modelContext
    @Bindable var sessionStore: SessionStore
    @Bindable var pairStore: PairStore
    @Bindable var consentStore: ConsentStore
    @Bindable var careStore: CareStore
    @Bindable var privacyStore: PrivacyStore
    @Bindable var realtimeStore: RealtimeStore
    @Bindable var connectivity: ConnectivityMonitor
    let notifications: PushNotificationCoordinator
    let appAttest: AppAttestCoordinator
    @State private var preparedAccountID: UUID?
    @State private var accountPreparationComplete = false

    var body: some View {
        Group {
            switch sessionStore.state {
            case .restoring:
                LaunchView()
            case .signedOut:
                AuthenticationView(store: sessionStore)
            case .signedIn(let user):
                if accountPreparationComplete, preparedAccountID == user.id {
                    MainShellView(
                        user: user,
                        sessionStore: sessionStore,
                        pairStore: pairStore,
                        consentStore: consentStore,
                        careStore: careStore,
                        privacyStore: privacyStore,
                        realtimeStore: realtimeStore,
                        connectivity: connectivity,
                        notifications: notifications,
                        appAttest: appAttest
                    )
                } else {
                    LaunchView()
                }
            }
        }
        .task { await sessionStore.restore() }
        .task(id: sessionStore.accountID) {
            let expectedAccount = sessionStore.accountID
            accountPreparationComplete = false
            await transitionAccount(to: expectedAccount)
            guard !Task.isCancelled, sessionStore.accountID == expectedAccount else { return }
            preparedAccountID = expectedAccount
            accountPreparationComplete = true
        }
    }

    private func transitionAccount(to newAccount: UUID?) async {
        await realtimeStore.clearAccountState()
        pairStore.clear()
        consentStore.clear()
        careStore.clear()
        privacyStore.clearAccountState()
        privacyStore.discardPersistedState(except: newAccount)

        try? CareDraftPersistence.clearAccounts(except: newAccount, in: modelContext)
    }
}

private struct LaunchView: View {
    var body: some View {
        ZStack {
            Brand.background.ignoresSafeArea()
            VStack(spacing: 18) {
                Image(systemName: "heart.circle.fill")
                    .font(.system(size: 66, weight: .semibold))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(Brand.coral, Brand.plum)
                    .accessibilityHidden(true)
                Text("RafayPair")
                    .font(.largeTitle.bold())
                ProgressView("Restoring your secure session")
                    .controlSize(.large)
            }
        }
    }
}

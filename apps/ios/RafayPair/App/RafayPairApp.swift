import SwiftData
import SwiftUI

@main
struct RafayPairApp: App {
    @UIApplicationDelegateAdaptor(PushApplicationDelegate.self) private var applicationDelegate
    @State private var sessionStore: SessionStore
    @State private var pairStore: PairStore
    @State private var consentStore: ConsentStore
    @State private var careStore: CareStore
    @State private var privacyStore: PrivacyStore
    @State private var realtimeStore: RealtimeStore
    @State private var connectivity = ConnectivityMonitor()
    private let notifications: PushNotificationCoordinator
    private let appAttest: AppAttestCoordinator

    init() {
        let dependencies = AppDependencies.live()
        _sessionStore = State(initialValue: SessionStore(repository: dependencies.auth))
        _pairStore = State(initialValue: PairStore(repository: dependencies.pair))
        _consentStore = State(initialValue: ConsentStore(repository: dependencies.consent))
        _careStore = State(
            initialValue: CareStore(repository: dependencies.care, pairRepository: dependencies.pair)
        )
        _privacyStore = State(initialValue: PrivacyStore(repository: dependencies.privacy))
        _realtimeStore = State(initialValue: RealtimeStore(client: dependencies.realtime))
        notifications = dependencies.notifications
        appAttest = dependencies.appAttest
        PushApplicationDelegate.coordinator = dependencies.notifications
    }

    var body: some Scene {
        WindowGroup {
            RootView(
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
            .tint(Brand.coral)
        }
        .modelContainer(for: CareDraft.self)
    }
}

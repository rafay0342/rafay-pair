import Foundation
import Network
import Observation

struct AppDependencies: Sendable {
    let auth: any AuthRepository
    let pair: any PairRepository
    let consent: any ConsentRepository
    let care: any CareRepository
    let privacy: any PrivacyRepository
    let realtime: RealtimeClient
    let notifications: PushNotificationCoordinator
    let appAttest: AppAttestCoordinator

    static func live(bundle: Bundle = .main) -> AppDependencies {
        guard
            let rawBaseURL = bundle.object(forInfoDictionaryKey: "RPAPIBaseURL") as? String,
            let baseURL = URL(string: rawBaseURL),
            let scheme = baseURL.scheme,
            scheme == "https" || (scheme == "http" && baseURL.isLoopback)
        else {
            preconditionFailure("RPAPIBaseURL must be HTTPS outside a loopback development build")
        }

        let vault = TokenVault()
        let api = APIClient(baseURL: baseURL, tokenVault: vault)
        let notificationState = NotificationStateVault()
        let notificationDelivery = SystemNotificationDelivery()
        let notificationDevices = RemoteNotificationDeviceService(
            api: api,
            stateVault: notificationState,
            installationIdentifier: InstallationIdentifier(),
            delivery: notificationDelivery
        )
        return AppDependencies(
            auth: RemoteAuthRepository(
                api: api,
                vault: vault,
                notificationDevices: notificationDevices
            ),
            pair: RemotePairRepository(api: api),
            consent: RemoteConsentRepository(api: api),
            care: RemoteCareRepository(api: api),
            privacy: RemotePrivacyRepository(api: api),
            realtime: RealtimeClient(api: api),
            notifications: PushNotificationCoordinator(
                service: notificationDevices,
                delivery: notificationDelivery
            ),
            appAttest: AppAttestCoordinator(
                service: SystemAppAttestService(),
                repository: RemoteAppAttestRepository(api: api),
                keyStore: AppAttestKeyIDVault()
            )
        )
    }
}

@MainActor
@Observable
final class ConnectivityMonitor {
    private let monitor: NWPathMonitor
    private let queue = DispatchQueue(label: "com.rafaypair.connectivity")
    private(set) var isConnected = false

    init(monitor: NWPathMonitor = NWPathMonitor()) {
        self.monitor = monitor
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor [weak self] in
                self?.isConnected = path.status == .satisfied
            }
        }
        monitor.start(queue: queue)
    }

    deinit {
        monitor.cancel()
    }
}

private extension URL {
    var isLoopback: Bool {
        guard let host else { return false }
        return host == "localhost" || host == "127.0.0.1" || host == "::1"
    }
}

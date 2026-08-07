import Foundation
import UIKit

actor PushNotificationCoordinator {
    private let service: RemoteNotificationDeviceService
    private let delivery: any NotificationDelivery

    init(
        service: RemoteNotificationDeviceService,
        delivery: any NotificationDelivery
    ) {
        self.service = service
        self.delivery = delivery
    }

    func activateForSignedInSession() async {
        await delivery.requestAuthorizationIfNeeded()
        await MainActor.run {
            // Alert authorization and APNs registration are independent. Registration is
            // still useful when visible alerts are denied because every remote payload is
            // contentless and only triggers an authenticated refresh.
            UIApplication.shared.registerForRemoteNotifications()
        }
        try? await service.registerStoredToken()
    }

    func receivedDeviceToken(_ data: Data) async {
        let token = data.map { String(format: "%02x", $0) }.joined()
        await service.recordAndRegister(apnsToken: token)
    }

    func handleContentAvailableWake() async -> UIBackgroundFetchResult {
        switch await service.performAuthenticatedCareWake() {
        case .newData: .newData
        case .noData: .noData
        case .failed: .failed
        }
    }
}

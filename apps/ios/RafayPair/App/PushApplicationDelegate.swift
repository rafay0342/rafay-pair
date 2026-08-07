import UIKit
import UserNotifications

@MainActor
final class PushApplicationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static var coordinator: PushNotificationCoordinator?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        guard let coordinator = Self.coordinator else { return }
        Task { await coordinator.receivedDeviceToken(deviceToken) }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // APNs registration is retried on the next signed-in activation. Do not log token,
        // account, or care metadata from this callback in production.
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        guard Self.isContentAvailableWake(userInfo), let coordinator = Self.coordinator else {
            completionHandler(.noData)
            return
        }
        Task {
            completionHandler(await coordinator.handleContentAvailableWake())
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        guard
            notification.request.content.userInfo["rafaypair-local-kind"] as? String == "authenticated-care-update"
        else {
            // Never render provider-supplied alert text while the app is foregrounded.
            return []
        }
        return [.banner, .list, .sound]
    }

    nonisolated static func isContentAvailableWake(_ userInfo: [AnyHashable: Any]) -> Bool {
        guard let aps = userInfo["aps"] as? [String: Any] else { return false }
        guard userInfo.count == 1, aps.count == 1 else { return false }
        if let value = aps["content-available"] as? Int { return value == 1 }
        if let value = aps["content-available"] as? NSNumber { return value.intValue == 1 }
        return false
    }
}

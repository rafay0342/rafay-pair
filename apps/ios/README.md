# RafayPair iOS

Native Swift 6 and SwiftUI client. The project is generated from `project.yml` with XcodeGen and
targets iOS 17 or newer.

## Local build and tests

```bash
xcodegen generate
xcodebuild \
  -project RafayPair.xcodeproj \
  -scheme RafayPair \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  build

xcodebuild \
  -project RafayPair.xcodeproj \
  -scheme RafayPair \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:RafayPairTests/PushNotificationTests \
  test
```

APNs registration requires a signed physical-device build. A simulator build verifies compilation
and notification policy tests but does not produce a production APNs device registration.

## APNs production configuration

The checked-in entitlement uses `$(RAFAYPAIR_APS_ENVIRONMENT)`: Debug/Development resolve to
`development`; Release resolves to `production`. Before archiving a distributable build:

1. Enable Push Notifications and Background Modes > Remote notifications for the
   `com.rafaypair.app` App ID in the Apple Developer account.
2. Use a distribution provisioning profile containing the production APS entitlement.
3. Configure the APNs signing key, key ID, issuer/team ID, and bundle-topic on the notification
   worker only. An APNs `.p8` key never belongs in this repository or app bundle.
4. Validate the signed archive entitlements and perform a real-device TestFlight wake test.

The accepted remote body is exactly:

```json
{"aps":{"content-available":1}}
```

No alert, care type, message, partner data, route, or request ID is accepted from APNs. A wake runs
the authenticated `/v1/auth/me` and `/v1/care-requests` flow; only a newly fetched pending incoming
request can schedule the fixed generic local text. Foreground provider alert text is suppressed.

The client stores APNs and returned device-registration state in Keychain. A separate non-secret
installation UUID is stored in app preferences and sent as `installationId`. Logout attempts
`DELETE /v1/notification-devices/{id}` before revoking the authentication session and clearing
Keychain credentials.

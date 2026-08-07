# iOS App Attest risk signal

RafayPair uses Apple's App Attest as authenticated risk telemetry. It is intentionally outside the authorization path: session, pair, privacy-pause, and directional-consent checks remain authoritative when App Attest is unsupported, delayed, elevated, or invalid. An attestation can never grant partner access, and a failed assertion alone never signs a user out.

## Native and server protocol

1. After an iOS session becomes active, the native coordinator checks `DCAppAttestService.isSupported`. An unsupported device still requests and consumes an `unsupported` challenge so the backend records an elevated-risk signal; the app never fabricates an attestation.
2. A supported installation loads the current user's key identifier from a `ThisDeviceOnly` Keychain entry or calls `generateKey()`. Each user on a device receives a distinct key identifier. Identifiers survive logout and normal app updates to avoid unnecessary key proliferation, but the Secure Enclave key and Keychain entry do not survive reinstall, migration, or backup restore.
3. The API mints a random 32-byte, two-minute, one-time challenge bound to the authenticated user, rotating session family, action, App Attest environment, and SHA-256 hash of the key identifier. It chooses `attestation` for an unknown key and `assertion` for an active key already registered to the same user and environment. Challenges are limited to three outstanding and ten per session family per hour.
4. The server returns canonical client data as unpadded base64url. The decoded UTF-8 bytes have this exact form, with line-feed separators and no final newline:

   ```text
   rafaypair.app-attest.v1
   POST
   /v1/integrity/ios/assessments
   <challenge UUID>
   session_start
   <attestation|assertion|unsupported>
   <unpadded base64url 32-byte server challenge>
   ```

   iOS computes SHA-256 over those exact decoded bytes and passes the 32-byte digest to `attestKey(_:clientDataHash:)` or `generateAssertion(_:clientDataHash:)`. The submit request does not contain client data or a client-selected challenge; the API reconstructs it from its locked database row.

5. For key attestation, the API strictly decodes bounded, definite-length CBOR and DER, validates the leaf and intermediate signatures through the pinned Apple App Attestation Root CA, checks certificate validity and CA roles, extracts the nonce extension `1.2.840.113635.100.8.2`, and compares it with `SHA256(authData || clientDataHash)`. It also checks the SHA-256 App ID, zero initial counter, production or sandbox/development AAGUID, credential ID, leaf P-256 X9.62 key hash, and matching COSE P-256 coordinates. Only the public SPKI key, opaque Apple receipt, environment, category/version metadata, and counter are retained. Raw attestations, key identifiers, server challenges, certificates, and private keys are not retained in assessments or logs.
6. For assertions, the API verifies the P-256 ECDSA signature over `SHA256(authenticatorData || SHA256(clientData))`, the App ID hash, and a counter strictly greater than the stored counter. The key row and challenge are locked in one transaction, and the counter update is conditional on the prior value, so concurrent, repeated, or out-of-order assertions cannot advance state twice.
7. The API consumes every syntactically valid submission exactly once, including an invalid cryptographic proof, and records only bounded metadata. A verified expected binary is `low_risk`; a verified pre-extension or unexpected category/version binary is `elevated_risk`; a challenge, key, signature, certificate, nonce, identity, environment, or replay failure is `invalid_binding`. All three are telemetry, not authorization.

Apple's newer `apple_validation_category_01` and `apple_bundle_version_01` authenticator extensions are policy inputs. Missing extensions from an otherwise valid older OS remain a verified but elevated-risk signal. Unexpected categories or `CFBundleVersion` values are also elevated, permitting investigation and rollout recovery without weakening cryptographic binding.

The client preserves a key after Apple's `serverUnavailable` attestation error and retries later, as Apple requires. It discards the key identifier after other attestation errors, an invalid-key assertion error, or a backend `invalid_binding` result, so reinstall and invalid-key recovery create a new key. Network failure while submitting a successfully generated proof does not erase the key. Foreground assessments are locally throttled to one attempt per 15 minutes and never block session restoration or care features.

Primary Apple guidance: [establishing app integrity](https://developer.apple.com/documentation/DeviceCheck/establishing-your-app-s-integrity), [server validation](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server), [the validation cross-check guide](https://developer.apple.com/documentation/devicecheck/attestation-object-validation-guide), and [preparing and ramping App Attest](https://developer.apple.com/documentation/DeviceCheck/preparing-to-use-the-app-attest-service). The pinned public trust anchor is published by [Apple's certificate authority](https://www.apple.com/certificateauthority/private/).

## Provisioning and deployment

- Register `com.rafaypair.app` under the protected Apple Developer team, enable App Attest for the identifier, and regenerate development and distribution provisioning profiles with the entitlement. The application target already signs `RafayPair.entitlements`; never add a private App Attest key or server credential to the binary.
- Configure API/Terraform values `APP_ATTEST_TEAM_ID`, `APP_ATTEST_BUNDLE_ID`, `APP_ATTEST_ENVIRONMENT`, `APP_ATTEST_ALLOWED_VALIDATION_CATEGORIES`, and `APP_ATTEST_ALLOWED_BUNDLE_VERSIONS`. Team and bundle IDs are public signing identifiers. Production API startup rejects a missing or partial policy. Terraform selects development for dev/staging and production for production.
- Treat `APP_ATTEST_ALLOWED_BUNDLE_VERSIONS` as an explicit `CFBundleVersion` release window, not `CFBundleShortVersionString`. Add the incoming build before rollout and remove the retired build only after the support window. Category `1` is the normal distributed iOS executable category; any additional category needs a documented platform use case and security review.
- A device-signed Release archive fails if its Apple team ID, registered bundle ID, production App Attest environment, or audited entitlement path is absent. Protected release automation also compares both the signed application's and provisioning profile's App Attest environment. Simulator builds remain unsigned and `isSupported == false` is expected.
- Development/ad hoc builds use the development entitlement and server environment. TestFlight, App Store, and Apple enterprise distribution operate in production; never submit development receipts or keys to the production endpoint. Keep environments isolated because Apple keys and receipts cannot cross them.
- Retain old database key rows rather than invalidating every installation during a deploy. Mark a compromised key `revoked_at` through a reviewed administrative incident procedure; do not silently reassign its hash to another account.

## Release evidence and operations

Before promotion, install the protected build on a physical App Attest-capable iPhone through the intended distribution channel. Retain sanitized evidence for one initial attestation and at least two assertions with strictly increasing counters, then confirm a replay is `409` or `invalid_binding`, an unexpected bundle version is elevated, logout does not erase the user's key identifier, and reinstall on the same device creates a new key. Simulator success is not real-device or Apple-certificate evidence.

Also retain the signed archive entitlement/profile comparison, API configuration test, migration result, pinned-root fingerprint check, Apple published-vector parser tests, and one sanitized `device_integrity.ios.assessed` audit. Alert on invalid-binding or elevated-risk rate shifts, challenge-limit spikes, App Attest availability changes, certificate-chain failures after Apple trust changes, and counters that stop advancing. Never attach raw attestation/assertion objects, receipts, key identifiers, server challenges, certificates, or Keychain exports to logs or incident tickets.

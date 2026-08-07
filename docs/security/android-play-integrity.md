# Android Play Integrity risk signal

RafayPair uses Google Play Standard Integrity as an authenticated risk signal. It is deliberately outside the authorization path: PostgreSQL session, pair, privacy, and directional-consent checks remain authoritative even when an integrity signal is absent or elevated. No integrity verdict can grant partner access, and a failed verdict alone cannot revoke an otherwise valid session.

## Runtime flow

1. The Android process creates a native `StandardIntegrityManager` from `com.google.android.play:integrity:1.6.0` and prepares one in-memory token provider at startup with the protected environment's public Google Cloud project number. Debug/development builds with no project number expose the capability as `UNSUPPORTED` and do not fabricate a token.
2. After an authenticated session is restored or created, the app requests a two-minute, one-time `session_start` challenge. Challenges are bound to the user and rotating session family, capped at three outstanding and ten per hour, and consumed transactionally before a provider call.
3. Android computes unpadded base64url SHA-256 over this exact UTF-8 canonical value, with line-feed separators and no final newline:

   ```text
   rafaypair.play-integrity.v1
   POST
   /v1/integrity/android/assessments
   <challenge UUID>
   session_start
   ```

4. Android supplies that digest through Standard Integrity `requestHash`, sends the resulting opaque encrypted token only to the RafayPair API, and never logs or persists it. An expired provider is prepared again and retried once, as Google recommends.
5. The API uses the `playintegrity` OAuth scope and backend-only Google credentials to call `https://playintegrity.googleapis.com/v1/<package>:decodeIntegrityToken`. Provider calls have an eight-second bound and no application retry, because a token may already have been decoded.
6. Before interpreting verdicts, the API checks the request package, app-integrity package, canonical request hash, timestamp (two-minute maximum age, 30-second future-clock tolerance), every returned signing-certificate digest against the environment allowlist, and the returned `versionCode` against the supported-version floor. It then records only bounded verdict labels, app version, allowlist-match state, testing-response state, and requested-at time. Tokens, credential data, certificate material, raw provider bodies, and request hashes are not stored.

Only a fresh production response with an allowlisted signer, a supported `versionCode`, `PLAY_RECOGNIZED`, `LICENSED`, and `MEETS_DEVICE_INTEGRITY` is classified `low_risk`. Testing responses, unlicensed apps, recognized versions below the supported floor, unrecognized versions, and missing device integrity are `elevated_risk`. Package, request-hash, freshness, missing identity fields, or signing-certificate failures are `invalid_binding`. These classifications feed security telemetry and investigation; they do not replace backend authorization.

Google Standard Integrity automatically clears verdicts when the same token is repeatedly decoded. RafayPair also consumes its own challenge once, so a replay either fails challenge consumption or produces a non-low-risk provider response. Provider failures produce sanitized security audits and a retryable 503; the original error and token are excluded.

## Production provisioning

- Enable Play Integrity API in a dedicated Google Cloud project and link that project to each matching app in Play Console (`com.rafaypair.android` production and the separately registered staging package). Configure quota alerts; Google's default quota is finite.
- Set `RAFAYPAIR_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER` as a protected Android CI variable. It is a public identifier embedded in the binary, not a credential. Staging and production distributable Gradle tasks fail if it is empty or malformed.
- Set `PLAY_INTEGRITY_PACKAGE_NAME` to the exact package registered in that environment. Terraform supplies the staging/production values explicitly.
- Set `PLAY_INTEGRITY_ALLOWED_CERTIFICATE_SHA256_DIGESTS` to 1-8 comma-separated, unpadded base64url SHA-256 digests from the Play Console app-signing certificates, and set `PLAY_INTEGRITY_MIN_VERSION_CODE` to the oldest still-supported build. The production Play App Signing certificate is normally different from the protected CI upload certificate; do not derive this allowlist from the upload keystore fingerprint. Include both old and new Play signing certificates only during a reviewed key-rotation window.
- Store `PLAY_INTEGRITY_GOOGLE_CREDENTIALS_JSON` only in the protected runtime secret. The API accepts a Google `service_account` credential or, preferably on ECS, an `external_account` Workload Identity Federation configuration tied to the API task role. Never put either form in Gradle properties, an APK, repository variables, logs, or Web bundles.
- Link the credential identity to the same Cloud project used by the app and permit only the identity exchange/service access needed for `decodeIntegrityToken`. Do not grant Play Console publishing or project-owner access to the runtime identity.
- Confirm the Play Console response configuration and validate a signed internal-track install on a physical certified device before promotion. The emulator/debug path is expected to remain unsupported and is not evidence of a production verdict.
- Review Google Play Integrity terms and update the Play data-safety disclosure for the request hash, app metadata, licensing state, and device attestation processing.

Primary implementation guidance: [Standard Integrity requests](https://developer.android.com/google/play/integrity/standard), [setup and library version](https://developer.android.com/google/play/integrity/setup), [verdict validation](https://developer.android.com/google/play/integrity/verdicts), and [terms/data safety](https://developer.android.com/google/play/integrity/terms).

## Release evidence and alerts

The release gate must retain the upload-artifact fingerprint, project-number configuration check, validated Play signing-certificate allowlist and version floor, API config test, migration result, and a real internal-track assessment showing a sanitized `device_integrity.android.assessed` audit. Alert on provider credential rejection, quota exhaustion, sustained provider unavailability, invalid binding, elevated-risk rate changes, and challenge-rate-limit spikes. Raw tokens and provider error bodies must never be attached to incident tickets.

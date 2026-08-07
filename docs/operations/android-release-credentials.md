# Getting the Android release identifiers

The Android release bundle needs five values: four that identify your Firebase
project (used for push notifications) and one that identifies your Google Cloud
project (used by Play Integrity, which checks the app has not been tampered
with). Debug and development builds do not need any of them — only
`bundleRelease` does.

All five are **free**. None of them requires a paid account, a card, or a Play
Store listing. None of them is a secret in the dangerous sense: they identify
your project publicly. The genuinely secret material — the service-account key
that lets the backend send notifications — never goes near the app and is
covered separately at the end.

Everything below takes about fifteen minutes and is done once.

---

## Part 1 — Firebase, for push notifications (four values)

1. Open <https://console.firebase.google.com> and sign in with a Google account.
2. Click **Create a project**. Name it anything — `rafaypair` is fine.
3. Google Analytics is offered. Turn it **off**; nothing here needs it.
4. Wait for the project to be created, then click **Continue**.
5. On the project home page, click the **Android** icon (a small robot) to add
   an Android app.
6. It asks for an **Android package name**. Type exactly:

   ```
   com.rafaypair.android
   ```

   The nickname and the debug signing certificate can be left empty.

7. Click **Register app**. It offers a `google-services.json` download —
   **you do not need that file.** Click through to the end and finish.
8. Now open **Project settings** (the gear icon, top left) → **General**.
   Scroll to "Your apps" and you will see the four values:

   | What the console calls it | What we call it                     |
   | ------------------------- | ----------------------------------- |
   | App ID                    | `RAFAYPAIR_FIREBASE_APPLICATION_ID` |
   | Web API Key               | `RAFAYPAIR_FIREBASE_API_KEY`        |
   | Project ID                | `RAFAYPAIR_FIREBASE_PROJECT_ID`     |
   | Project number            | `RAFAYPAIR_FIREBASE_SENDER_ID`      |

   The App ID looks like `1:123456789012:android:abc123def456`. The Project
   number is a plain number like `123456789012`.

---

## Part 2 — Play Integrity, one value

Play Integrity uses the **Google Cloud project number**, which Firebase already
created for you behind the scenes.

1. Open <https://console.cloud.google.com>.
2. At the top, use the project picker and select the project Firebase made — it
   has the same name you chose.
3. On the **Dashboard**, the "Project info" card shows **Project number**.

That number is `RAFAYPAIR_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER`. It is usually the
same number as the Firebase Project number above.

---

## Part 3 — Put the values in

Create `apps/android/local.properties` (this file is git-ignored, so the values
stay on your machine) and paste, replacing the examples:

```properties
RAFAYPAIR_FIREBASE_APPLICATION_ID=1:123456789012:android:abc123def456
RAFAYPAIR_FIREBASE_API_KEY=AIzaSyExampleExampleExampleExampleExample
RAFAYPAIR_FIREBASE_PROJECT_ID=rafaypair
RAFAYPAIR_FIREBASE_SENDER_ID=123456789012
RAFAYPAIR_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER=123456789012
```

Then check it worked:

```bash
make android
```

The build script skips `bundleRelease` when the values are absent and includes it
when they are present, so a successful run that mentions `bundleRelease` means
the identifiers were picked up.

---

## Part 4 — The backend's notification credential (separate, and actually secret)

The app identifies the project; the **server** is what actually sends a
notification, and that needs a private key. It is deliberately never bundled into
the app.

1. Firebase console → **Project settings** → **Service accounts**.
2. Click **Generate new private key** and confirm. A `.json` file downloads.
3. Open it and copy three fields into the backend environment — not into
   `local.properties`, and not into the repository:

   ```
   FCM_PROJECT_ID      ← "project_id"
   FCM_CLIENT_EMAIL    ← "client_email"
   FCM_PRIVATE_KEY     ← "private_key"
   ```

4. Delete the downloaded file once the values are in place.

Treat that key the way you would a password. Anyone holding it can send
notifications as your project. It is the one item on this page that matters if it
leaks; the five identifiers above do not.

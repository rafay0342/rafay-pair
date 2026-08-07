import SwiftData
import SwiftUI

struct SettingsView: View {
    @Environment(\.modelContext) private var modelContext
    let user: User
    @Bindable var sessionStore: SessionStore
    @Bindable var pairStore: PairStore
    @Bindable var consentStore: ConsentStore
    @Bindable var careStore: CareStore
    @Bindable var privacyStore: PrivacyStore
    @State private var confirmDisconnect = false
    @State private var confirmLogout = false

    var body: some View {
        List {
            Section("Account") {
                LabeledContent("Name", value: user.displayName)
                LabeledContent("Email", value: user.email)
                LabeledContent("Member since", value: user.createdAt.formatted(date: .abbreviated, time: .omitted))
            }

            Section("Privacy pause") {
                VStack(alignment: .leading, spacing: 10) {
                    Label(
                        privacyStore.state.paused ? "Partner sharing is paused" : "Partner sharing is active",
                        systemImage: privacyStore.state.paused ? "pause.circle.fill" : "checkmark.shield.fill"
                    )
                    .font(.headline)
                    .foregroundStyle(privacyStore.state.paused ? Brand.coral : Brand.mint)
                    Text(
                        privacyStore.state.paused
                            ? "No new partner-visible state leaves this phone."
                            : "Only the permissions enabled in Consent center can be shared."
                    )
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    Button(privacyStore.state.paused ? "Resume sharing" : "Pause now") {
                        Task {
                            if privacyStore.state.paused {
                                await privacyStore.resume()
                            } else {
                                await privacyStore.pause()
                            }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(privacyStore.state.paused ? Brand.mint : Brand.coral)
                    .disabled(privacyStore.isMutating || privacyStore.serverSyncPending)
                }
                .padding(.vertical, 4)
            }

            if pairStore.pair != nil {
                Section("Pair") {
                    Button("Disconnect pair", role: .destructive) { confirmDisconnect = true }
                    Text(
                        "Disconnecting revokes all partner permissions and live access. It cannot be undone; pairing again starts with consent off."
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }

            Section {
                Button("Sign out", role: .destructive) { confirmLogout = true }
            }
        }
        .navigationTitle("Settings")
        .confirmationDialog(
            "Disconnect this pair?",
            isPresented: $confirmDisconnect,
            titleVisibility: .visible
        ) {
            Button("Disconnect and revoke access", role: .destructive) {
                Task {
                    do {
                        let disconnectedPairID = pairStore.pair?.id
                        try await pairStore.disconnect()
                        consentStore.clear()
                        careStore.clear()
                        if let disconnectedPairID {
                            try? CareDraftPersistence.clear(
                                ownerUserID: user.id,
                                pairID: disconnectedPairID,
                                in: modelContext
                            )
                        }
                        privacyStore.clearAccountState()
                    } catch {
                        // PairStore exposes a user-safe error alert.
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your partner immediately loses access to all shared state.")
        }
        .confirmationDialog("Sign out of RafayPair?", isPresented: $confirmLogout, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await sessionStore.logout() } }
            Button("Cancel", role: .cancel) {}
        }
        .errorAlert(
            message: Binding(
                get: { pairStore.errorMessage ?? privacyStore.errorMessage },
                set: { value in
                    if value == nil {
                        pairStore.errorMessage = nil
                        privacyStore.errorMessage = nil
                    }
                }
            ))
    }
}

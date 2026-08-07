import SwiftUI

struct ConsentView: View {
    @Bindable var pairStore: PairStore
    @Bindable var store: ConsentStore

    var body: some View {
        List {
            Section {
                Text(
                    "Pairing starts with every sharing permission off. Changes are recorded by the server and apply only to your current partner."
                )
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }

            if pairStore.pair?.status == .active {
                Section("Your partner may receive") {
                    ForEach(ConsentScope.allCases) { scope in
                        Toggle(
                            isOn: Binding(
                                get: { store.isEnabled(scope) },
                                set: { enabled in Task { await store.set(scope, enabled: enabled) } }
                            )
                        ) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(scope.title).font(.headline)
                                Text(scope.explanation)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .disabled(store.updatingScopes.contains(scope))
                        .accessibilityHint("Updates this permission on the RafayPair server")
                    }
                }
            } else {
                ContentUnavailableView(
                    "No active pair",
                    systemImage: "person.2.slash",
                    description: Text("Connect with your partner before choosing sharing permissions.")
                )
            }

            Section("Always private") {
                Label(
                    "Your partner cannot activate this phone's camera or microphone.",
                    systemImage: "camera.badge.ellipsis")
                Label("Raw camera frames are not shared during care or workouts.", systemImage: "video.slash.fill")
                Label("You can pause all partner sharing immediately.", systemImage: "pause.circle.fill")
            }
            .font(.subheadline)
        }
        .navigationTitle("Consent center")
        .refreshable { await store.load() }
        .overlay {
            if store.isLoading, store.grants.isEmpty { ProgressView("Loading permissions") }
        }
        .errorAlert(message: $store.errorMessage)
    }
}

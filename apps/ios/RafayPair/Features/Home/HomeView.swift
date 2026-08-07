import SwiftUI

struct HomeView: View {
    let user: User
    @Bindable var pairStore: PairStore
    @Bindable var privacyStore: PrivacyStore
    @Bindable var realtimeStore: RealtimeStore

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                header

                if privacyStore.state.paused {
                    PrivacyPausedBanner(store: privacyStore)
                }

                if let pair = pairStore.pair {
                    pairedCard(pair)
                } else if pairStore.isLoading {
                    RPCard {
                        HStack {
                            ProgressView()
                            Text("Checking your pair…")
                        }
                    }
                } else {
                    PairSetupView(store: pairStore)
                }

                RPCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Your privacy boundary", systemImage: "lock.shield.fill")
                            .font(.headline)
                            .foregroundStyle(Brand.plum)
                        Text(
                            "Only permissions you explicitly enable are shared. Camera and microphone sessions can only start on this phone, by you."
                        )
                        .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(18)
        }
        .background(Brand.background.ignoresSafeArea())
        .navigationTitle("Today")
        .refreshable {
            async let pair: Void = pairStore.load()
            async let privacy: Void = privacyStore.load()
            _ = await (pair, privacy)
        }
        .errorAlert(message: $pairStore.errorMessage)
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Hello, \(user.displayName)")
                    .font(.title.bold())
                Text("A quiet place to stay connected.")
                    .foregroundStyle(.secondary)
            }
            Spacer()
            connectionIndicator
        }
    }

    private var connectionIndicator: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(
                    privacyStore.state.paused
                        ? Color.secondary
                        : realtimeStore.connectionState == .connected ? Brand.mint : Color.orange
                )
                .frame(width: 8, height: 8)
            Text(
                privacyStore.state.paused
                    ? "Paused"
                    : realtimeStore.connectionState == .connected ? "Live" : "Reconnecting"
            )
            .font(.caption.weight(.semibold))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(.thinMaterial, in: Capsule())
        .accessibilityElement(children: .combine)
    }

    private func pairedCard(_ pair: PairSummary) -> some View {
        RPCard {
            VStack(alignment: .leading, spacing: 16) {
                Label(pair.status == .active ? "Paired" : "Waiting for your person", systemImage: "person.2.fill")
                    .font(.title3.bold())

                ForEach(pair.members) { member in
                    HStack(spacing: 12) {
                        Image(systemName: member.id == user.id ? "person.crop.circle.fill" : "heart.circle.fill")
                            .font(.title2)
                            .foregroundStyle(member.id == user.id ? Brand.plum : Brand.coral)
                        VStack(alignment: .leading) {
                            Text(member.displayName).font(.headline)
                            Text(member.id == user.id ? "You" : "Your partner")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                if let code = pair.joinCode, pair.status == .waiting {
                    Divider()
                    VStack(alignment: .leading, spacing: 8) {
                        Text("One-time pairing code")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(code)
                            .font(.system(.title, design: .monospaced, weight: .bold))
                            .textSelection(.enabled)
                            .accessibilityLabel("Pairing code \(code.map(String.init).joined(separator: " "))")
                        ShareLink(
                            item: code, subject: Text("RafayPair code"),
                            message: Text(
                                "Open RafayPair and enter this one-time code. Share it only with the person you intend to pair with."
                            )
                        ) {
                            Label("Share securely", systemImage: "square.and.arrow.up")
                        }
                    }
                }
            }
        }
    }
}

private struct PrivacyPausedBanner: View {
    @Bindable var store: PrivacyStore

    var body: some View {
        RPCard {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: "pause.circle.fill")
                    .font(.largeTitle)
                    .foregroundStyle(.white)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Sharing is paused")
                        .font(.headline)
                    Text(
                        store.serverSyncPending
                            ? "This phone stopped sharing immediately. Server sync is pending."
                            : "Your partner cannot receive new shared state until you resume."
                    )
                    .font(.subheadline)
                }
                Spacer()
            }
            .foregroundStyle(.white)
        }
        .background(Brand.plum, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

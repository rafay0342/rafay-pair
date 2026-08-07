import SwiftData
import SwiftUI

struct CareView: View {
    let user: User
    @Bindable var pairStore: PairStore
    @Bindable var careStore: CareStore
    @Bindable var privacyStore: PrivacyStore
    @Query private var persistedDrafts: [CareDraft]
    @State private var showsComposer = false

    private var canShareCare: Bool {
        pairStore.pair?.status == .active && privacyStore.isSharingAllowed
    }

    private var queuedCount: Int {
        guard let pairID = pairStore.pair?.id else { return 0 }
        return persistedDrafts.count {
            $0.ownerUserID == user.id && $0.pairID == pairID && $0.deliveryState == .queued
        }
    }

    var body: some View {
        Group {
            if pairStore.pair?.status != .active {
                ContentUnavailableView(
                    "Pair first",
                    systemImage: "hands.sparkles",
                    description: Text("Care requests are delivered only inside an active, consented pair.")
                )
            } else if privacyStore.state.paused || privacyStore.serverSyncPending {
                ContentUnavailableView(
                    "Care sharing is paused",
                    systemImage: "pause.circle.fill",
                    description: Text("Resume privacy sharing before sending or responding to care requests.")
                )
            } else if careStore.requests.isEmpty, !careStore.isLoading {
                ContentUnavailableView {
                    Label("No care requests yet", systemImage: "heart.text.square")
                } description: {
                    Text("Send a gentle check-in when care-request consent is enabled.")
                } actions: {
                    Button("Send care request") { showsComposer = true }
                        .buttonStyle(.borderedProminent)
                        .disabled(!canShareCare)
                }
            } else {
                List(careStore.requests) { request in
                    CareRequestRow(
                        request: request,
                        currentUserID: user.id,
                        store: careStore,
                        privacyStore: privacyStore
                    )
                }
                .refreshable { await careStore.load() }
            }
        }
        .navigationTitle("Care")
        .safeAreaInset(edge: .bottom) {
            if queuedCount > 0 {
                Text("\(queuedCount) care request\(queuedCount == 1 ? "" : "s") queued securely")
                    .font(.caption.weight(.semibold))
                    .padding(10)
                    .background(.thinMaterial, in: Capsule())
            }
        }
        .toolbar {
            if pairStore.pair?.status == .active {
                ToolbarItem(placement: .primaryAction) {
                    Button("New", systemImage: "plus") { showsComposer = true }
                        .disabled(!canShareCare)
                }
            }
        }
        .sheet(isPresented: $showsComposer) {
            if let pairID = pairStore.pair?.id {
                CareComposerView(
                    ownerUserID: user.id,
                    pairID: pairID,
                    store: careStore,
                    privacyStore: privacyStore
                )
            }
        }
        .overlay {
            if careStore.isLoading, careStore.requests.isEmpty { ProgressView("Loading care") }
        }
        .errorAlert(message: $careStore.errorMessage)
    }
}

private struct CareRequestRow: View {
    let request: CareRequest
    let currentUserID: UUID
    @Bindable var store: CareStore
    @Bindable var privacyStore: PrivacyStore

    private var isIncoming: Bool { request.recipientUserId == currentUserID }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label(request.kind.title, systemImage: icon)
                    .font(.headline)
                Spacer()
                Text(request.status.rawValue.capitalized)
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(statusColor.opacity(0.14), in: Capsule())
                    .foregroundStyle(statusColor)
            }
            Text(isIncoming ? "From your partner" : "Sent to your partner")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if let message = request.message, !message.isEmpty {
                Text(message)
            }
            Text(request.createdAt, style: .relative)
                .font(.caption)
                .foregroundStyle(.secondary)

            if isIncoming, request.status == .pending {
                HStack {
                    Button("Decline", role: .destructive) {
                        Task {
                            await store.respond(
                                to: request,
                                with: .declined,
                                sharingAllowed: privacyStore.isSharingAllowed
                            )
                        }
                    }
                    .buttonStyle(.bordered)
                    Button("Accept") {
                        Task {
                            await store.respond(
                                to: request,
                                with: .accepted,
                                sharingAllowed: privacyStore.isSharingAllowed
                            )
                        }
                    }
                    .buttonStyle(.borderedProminent)
                }
                .disabled(store.respondingIDs.contains(request.id) || !privacyStore.isSharingAllowed)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .contain)
    }

    private var icon: String {
        switch request.kind {
        case .checkIn: "message.badge.fill"
        case .encouragement: "sparkles"
        case .breatheTogether: "wind"
        case .moveTogether: "figure.walk"
        case .help: "hand.raised.fill"
        case .callMe: "phone.fill"
        }
    }

    private var statusColor: Color {
        switch request.status {
        case .accepted: Brand.mint
        case .declined, .expired: .secondary
        case .pending: .orange
        }
    }
}

private struct CareComposerView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \CareDraft.modifiedAt, order: .reverse) private var drafts: [CareDraft]
    let ownerUserID: UUID
    let pairID: UUID
    @Bindable var store: CareStore
    @Bindable var privacyStore: PrivacyStore
    @State private var selectedKind: CareRequestKind = .checkIn
    @State private var note = ""
    @State private var draftID = UUID()

    private var scopedDrafts: [CareDraft] {
        drafts.filter {
            $0.ownerUserID == ownerUserID && $0.pairID == pairID && $0.deliveryState == .draft
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("What do you need?") {
                    Picker("Care request", selection: $selectedKind) {
                        ForEach(CareRequestKind.allCases) { kind in
                            Text(kind.title).tag(kind)
                        }
                    }
                }
                Section("A short note (optional)") {
                    TextField("Say what would feel helpful", text: $note, axis: .vertical)
                        .lineLimit(3...6)
                        .onChange(of: note) { _, newValue in
                            if newValue.count > 500 { note = String(newValue.prefix(500)) }
                            persistDraft()
                        }
                    Text("\(note.count)/500")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Section {
                    Text(
                        "Sending rechecks your active pair and your partner's current care-request consent. If the network is unavailable after you tap Send, this request is queued with the same idempotency key and retried securely."
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Care request")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") {
                        Task {
                            let draft = persistDraft()
                            let outcome = await store.send(
                                draft: draft,
                                privacyStore: privacyStore,
                                modelContext: modelContext
                            )
                            if outcome == .sent || outcome == .queued {
                                dismiss()
                            }
                        }
                    }
                    .disabled(store.isSending || !privacyStore.isSharingAllowed)
                }
            }
            .onAppear { restoreDraft() }
            .onChange(of: selectedKind) { _, _ in persistDraft() }
            .errorAlert(message: $store.errorMessage)
        }
        .interactiveDismissDisabled(store.isSending)
    }

    private func restoreDraft() {
        guard let draft = scopedDrafts.first else {
            let draft = CareDraft(
                id: draftID,
                ownerUserID: ownerUserID,
                pairID: pairID,
                kind: selectedKind,
                note: note
            )
            modelContext.insert(draft)
            try? modelContext.save()
            return
        }
        draftID = draft.id
        selectedKind = draft.kind
        note = draft.note
    }

    @discardableResult
    private func persistDraft() -> CareDraft {
        let draft: CareDraft
        if let existing = scopedDrafts.first(where: { $0.id == draftID }) {
            draft = existing
        } else {
            draft = CareDraft(id: draftID, ownerUserID: ownerUserID, pairID: pairID)
            modelContext.insert(draft)
        }
        draft.kind = selectedKind
        draft.note = note
        draft.modifiedAt = Date()
        try? modelContext.save()
        return draft
    }

    private func removeDraft() {
        guard let draft = scopedDrafts.first(where: { $0.id == draftID }) else { return }
        modelContext.delete(draft)
        try? modelContext.save()
    }
}

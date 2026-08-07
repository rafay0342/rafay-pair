import SwiftUI

/// Together mode and the assistant's memory.
///
/// Master specification §10: both phones detect their own user and exchange only
/// derived state. Nothing on this screen sends a frame, a landmark, or audio.
struct TogetherView: View {
    let user: User
    @Bindable var pairStore: PairStore
    @Bindable var privacyStore: PrivacyStore
    let together: any TogetherRepository
    let assistant: any AssistantRepository

    @State private var session: TogetherSession?
    @State private var memories: [AiMemory] = []
    @State private var memoryLimit = 0
    @State private var newMemory = ""
    @State private var memoryCategory: AiMemoryCategory = .preference
    @State private var busy = false
    @State private var errorMessage: String?

    private var partner: PairMember? {
        pairStore.pair?.members.first { $0.userId != user.id }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                header
                if let message = errorMessage {
                    RPCard {
                        Text(message).foregroundStyle(Color.orange)
                    }
                }
                togetherCard
                assistantCard
                memoryCard
            }
            .padding(18)
        }
        .background(Brand.background.ignoresSafeArea())
        .navigationTitle("Together")
        .task {
            await reloadSession()
            await reloadMemories()
        }
        .refreshable {
            await reloadSession()
            await reloadMemories()
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Work out at the same time.")
                .font(.title.bold())
            Text(
                "Each phone watches only its own person. What crosses between you is the count and the phase — never the camera."
            )
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Together

    @ViewBuilder
    private var togetherCard: some View {
        RPCard {
            VStack(alignment: .leading, spacing: 12) {
                Label("Shared session", systemImage: "person.2.fill")
                    .font(.headline)
                    .foregroundStyle(Brand.plum)

                if partner == nil {
                    Text("Together mode needs an active pair.")
                        .foregroundStyle(.secondary)
                } else if !privacyStore.isSharingAllowed {
                    Text("Resume sharing before starting a session together.")
                        .foregroundStyle(.secondary)
                } else if let session {
                    sessionDetail(session)
                } else {
                    Text(
                        "They will be asked before anything is shared, and either of you can end it at any moment."
                    )
                    .foregroundStyle(.secondary)
                    ForEach(TogetherActivity.allCases, id: \.self) { activity in
                        Button(activityLabel(activity)) {
                            Task { await invite(activity) }
                        }
                        .buttonStyle(.bordered)
                        .disabled(busy)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func sessionDetail(_ session: TogetherSession) -> some View {
        Text(activityLabel(session.activity))
            .font(.headline)
        Text(statusLabel(session))
            .foregroundStyle(.secondary)

        ForEach(session.participants) { participant in
            Text(
                "\(participant.repetitions) reps · set \(participant.setIndex + 1) · \(participant.exercisePhase.rawValue)"
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
        }

        if session.status == .invited, session.invitedUserId == user.id {
            HStack {
                Button("Join") { Task { await respond(accepted: true) } }
                    .buttonStyle(.borderedProminent)
                Button("Not now") { Task { await respond(accepted: false) } }
                    .buttonStyle(.bordered)
            }
            .disabled(busy)
        }

        Button("End session") { Task { await end() } }
            .buttonStyle(.bordered)
            .disabled(busy)

        Text(
            "Repetition count, phase, set, elapsed time, estimated calories, and breathing phase. That is the whole list."
        )
        .font(.caption2)
        .foregroundStyle(.tertiary)
    }

    // MARK: - Assistant

    private var assistantCard: some View {
        RPCard {
            VStack(alignment: .leading, spacing: 8) {
                Label("Rafay AI", systemImage: "waveform")
                    .font(.headline)
                    .foregroundStyle(Brand.plum)
                Text("A generated voice, not a person, and not a clinician.")
                    .font(.subheadline.weight(.semibold))
                Text(
                    "It says so at the start of every session, and it speaks about camera estimates as estimates rather than measured readings."
                )
                .foregroundStyle(.secondary)
                Text(
                    "Anything it does on your behalf asks you first. It cannot confirm on its own."
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
    }

    private var memoryCard: some View {
        RPCard {
            VStack(alignment: .leading, spacing: 12) {
                Label("What Rafay remembers", systemImage: "brain")
                    .font(.headline)
                    .foregroundStyle(Brand.plum)
                Text(
                    "\(memories.count) of \(memoryLimit) entries. Yours alone — your partner cannot see these, and they do not travel with the pair."
                )
                .font(.footnote)
                .foregroundStyle(.secondary)

                Picker("Kind", selection: $memoryCategory) {
                    ForEach(AiMemoryCategory.allCases, id: \.self) { category in
                        Text(category.rawValue.capitalized).tag(category)
                    }
                }
                .pickerStyle(.segmented)

                TextField("Remember that…", text: $newMemory)
                    .textFieldStyle(.roundedBorder)

                Button("Add") { Task { await addMemory() } }
                    .buttonStyle(.bordered)
                    .disabled(busy || newMemory.trimmingCharacters(in: .whitespaces).isEmpty)

                ForEach(memories) { memory in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(memory.content)
                            HStack(spacing: 6) {
                                Text(memory.category.rawValue)
                                // An entry the model proposed is marked, so it is
                                // always clear which of these you said.
                                if memory.author == "assistant" {
                                    Text("suggested by Rafay").italic()
                                }
                            }
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        }
                        Spacer()
                        Button("Delete") { Task { await deleteMemory(memory.id) } }
                            .font(.footnote)
                            .disabled(busy)
                    }
                }

                if !memories.isEmpty {
                    Button("Forget everything") { Task { await forgetAll() } }
                        .font(.footnote)
                        .foregroundStyle(Color.red)
                        .disabled(busy)
                }
            }
        }
    }

    // MARK: - Actions

    private func reloadSession() async {
        do {
            session = try await together.current()
            errorMessage = nil
        } catch {
            // An ended pair or a privacy pause is a state, not a failure.
            session = nil
        }
    }

    private func reloadMemories() async {
        do {
            let response = try await assistant.memories()
            memories = response.memories
            memoryLimit = response.limit
        } catch {
            errorMessage = "Could not load what Rafay remembers."
        }
    }

    private func perform(_ action: @escaping () async throws -> Void) async {
        busy = true
        defer { busy = false }
        do {
            try await action()
            errorMessage = nil
        } catch {
            errorMessage = "That did not go through. Try again in a moment."
        }
    }

    private func invite(_ activity: TogetherActivity) async {
        await perform { session = try await together.invite(activity: activity) }
    }

    private func respond(accepted: Bool) async {
        guard let current = session else { return }
        await perform {
            session = try await together.respond(id: current.id, accepted: accepted)
        }
    }

    private func end() async {
        guard let current = session else { return }
        await perform { session = try await together.end(id: current.id) }
    }

    private func addMemory() async {
        let content = newMemory.trimmingCharacters(in: .whitespaces)
        guard !content.isEmpty else { return }
        await perform {
            _ = try await assistant.addMemory(category: memoryCategory, content: content)
            newMemory = ""
            await reloadMemories()
        }
    }

    private func deleteMemory(_ id: UUID) async {
        await perform {
            try await assistant.deleteMemory(id: id)
            await reloadMemories()
        }
    }

    private func forgetAll() async {
        await perform {
            try await assistant.forgetAll()
            await reloadMemories()
        }
    }

    private func activityLabel(_ activity: TogetherActivity) -> String {
        switch activity {
        case .squat: "Squats together"
        case .bodyweightMixed: "Mixed bodyweight together"
        case .guidedBreathing: "Breathing together"
        }
    }

    private func statusLabel(_ session: TogetherSession) -> String {
        switch session.status {
        case .invited:
            session.invitedUserId == user.id
                ? "Your partner is asking to train together."
                : "Waiting for an answer."
        case .active: "In progress."
        case .declined: "Declined."
        case .ended: "Ended."
        case .expired: "The invitation expired."
        }
    }
}

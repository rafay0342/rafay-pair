import SwiftUI

/// The voice conversation surface.
///
/// The disclosure is the first thing on the card and stays there for the whole
/// session rather than appearing once and scrolling away, and the microphone
/// indicator reflects the audio engine's actual state rather than the app's
/// belief about it.
struct VoiceSessionView: View {
    @Bindable var store: VoiceSessionStore

    var body: some View {
        RPCard {
            VStack(alignment: .leading, spacing: 12) {
                Label("Talk to Rafay AI", systemImage: "waveform")
                    .font(.headline)
                    .foregroundStyle(Brand.plum)

                Text(store.disclosure)
                    .font(.subheadline.weight(.semibold))

                switch store.phase {
                case .idle:
                    Text("It hears you only while a session is running, and stops the moment you end it.")
                        .foregroundStyle(.secondary)
                    Button("Start a voice session") { Task { await store.start() } }
                        .buttonStyle(.borderedProminent)

                case .starting:
                    ProgressView("Opening…")

                case .listening:
                    HStack(spacing: 8) {
                        Image(systemName: store.microphoneOn ? "mic.fill" : "mic.slash.fill")
                            .foregroundStyle(store.microphoneOn ? Color.red : .secondary)
                        Text(store.microphoneOn ? "Listening" : "Microphone off")
                            .font(.subheadline.weight(.semibold))
                    }
                    Button("End session") { Task { await store.stop() } }
                        .buttonStyle(.bordered)

                case .ending:
                    ProgressView("Ending…")

                case .unavailable(let message):
                    Text(message).foregroundStyle(Color.orange)
                    Button("Try again") { Task { await store.start() } }
                        .buttonStyle(.bordered)
                }

                if let pending = store.pendingConfirmation {
                    confirmation(pending)
                }

                if !store.transcript.isEmpty {
                    Divider()
                    ForEach(Array(store.transcript.enumerated()), id: \.offset) { line in
                        Text(line.element)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    /// Asked here, in the interface, rather than answered by speech: a spoken
    /// "shall I?" answered aloud would make the model both the asker and the
    /// recorder of the answer.
    private func confirmation(_ pending: VoiceToolConfirmation) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            Text("Rafay AI is asking to: \(pending.title)")
                .font(.subheadline.weight(.semibold))
            HStack {
                Button("Allow once") { Task { await store.confirm() } }
                    .buttonStyle(.borderedProminent)
                Button("No") { Task { await store.decline() } }
                    .buttonStyle(.bordered)
            }
        }
    }
}

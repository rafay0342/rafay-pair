import Foundation
import Observation

/// Drives one voice conversation with Rafay AI.
///
/// The order below is the product commitment, expressed as control flow: a
/// session exists, its disclosure is shown, the disclosure is recorded as shown,
/// and only then is a socket opened. The server refuses a socket for a session
/// that never announced itself, so this order cannot be skipped by a client that
/// forgets it — but it is written here plainly anyway.
@MainActor
@Observable
final class VoiceSessionStore {
    enum Phase: Equatable {
        case idle
        case starting
        case listening
        case ending
        case unavailable(String)
    }

    private(set) var phase: Phase = .idle
    private(set) var session: AiSession?
    private(set) var transcript: [String] = []
    private(set) var pendingConfirmation: VoiceToolConfirmation?
    private(set) var lastToolDecision: String?
    private(set) var microphoneOn = false

    private let assistant: any AssistantRepository
    private let client: VoiceClient
    private var eventTask: Task<Void, Never>?

    init(assistant: any AssistantRepository, client: VoiceClient) {
        self.assistant = assistant
        self.client = client
    }

    var disclosure: String {
        session?.identityDisclosure
            ?? "Rafay AI is a generated voice, not a person, and not a clinician."
    }

    func start() async {
        guard phase == .idle else { return }
        phase = .starting
        transcript = []
        lastToolDecision = nil

        guard await VoiceClient.requestMicrophoneAccess() else {
            phase = .unavailable("Rafay AI needs the microphone to hear you.")
            return
        }

        do {
            // An existing session is reused rather than stacked: the server
            // allows one at a time, and starting a second would only fail.
            var started = try await assistant.currentSession()
            if started == nil {
                started = try await assistant.startSession()
            }
            guard let opened = started else {
                phase = .unavailable("A voice session could not be started.")
                return
            }
            session = opened

            // Recorded before any audio can play, which is what makes the
            // requirement auditable rather than aspirational.
            let announced = try await assistant.markIdentityAnnounced(id: opened.id)
            session = announced ?? opened

            let ticket = try await assistant.voiceTicket(id: opened.id)
            listen()
            try await client.start(ticket: ticket)
            microphoneOn = await client.isListening()
            phase = .listening
        } catch APIError.server(let problem) where problem.status == 503 {
            phase = .unavailable("Voice is not available on this deployment yet.")
        } catch APIError.server(let problem) where problem.code == "PRIVACY_PAUSED" {
            phase = .unavailable("Resume sharing before starting a voice session.")
        } catch {
            phase = .unavailable("The voice session could not be opened.")
        }
    }

    func stop() async {
        guard phase == .listening || phase == .starting else { return }
        phase = .ending
        await client.stop()
        eventTask?.cancel()
        eventTask = nil
        microphoneOn = false
        pendingConfirmation = nil
        if let id = session?.id {
            _ = try? await assistant.endSession(id: id)
        }
        session = nil
        phase = .idle
    }

    func confirm() async {
        guard let pending = pendingConfirmation else { return }
        pendingConfirmation = nil
        await client.confirm(callId: pending.callId)
    }

    func decline() async {
        guard let pending = pendingConfirmation else { return }
        pendingConfirmation = nil
        await client.decline(callId: pending.callId)
    }

    private func listen() {
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            guard let self else { return }
            for await event in await self.client.events() {
                await self.apply(event)
            }
        }
    }

    private func apply(_ event: VoiceClientEvent) async {
        switch event {
        case .ready:
            microphoneOn = await client.isListening()
        case .transcript(let text, let final):
            // Only completed lines are kept. A partial line rewritten in place
            // reads as the assistant changing its mind about what you said.
            if final { transcript.append(text) }
        case .confirmationRequested(let confirmation):
            pendingConfirmation = confirmation
        case .toolSettled(_, let decision):
            lastToolDecision = decision
        case .failed(let reason):
            phase = .unavailable(friendly(reason))
            await stopAfterFailure()
        case .closed:
            await stopAfterFailure()
        }
    }

    private func stopAfterFailure() async {
        await client.stop()
        eventTask?.cancel()
        eventTask = nil
        microphoneOn = false
        pendingConfirmation = nil
        if let id = session?.id { _ = try? await assistant.endSession(id: id) }
        session = nil
        if case .unavailable = phase {} else { phase = .idle }
    }

    private func friendly(_ reason: String) -> String {
        switch reason {
        case "frame_too_large": "That audio frame was too large to send."
        case "provider_error", "transport_error", "transport":
            "The connection to the voice service dropped."
        default: "The voice session stopped."
        }
    }
}

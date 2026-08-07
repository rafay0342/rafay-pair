import AVFoundation
import Foundation

/// The AI voice socket.
///
/// Audio goes to the server, never to a provider directly: the server holds the
/// credential, composes the instructions, and is the only thing that may
/// authorize a tool call. A client that talked to the provider itself would
/// have to be trusted with all three.
enum VoiceHandshake {
    static let applicationProtocol = "rafaypair.voice.v1"
    static let ticketProtocolPrefix = "rafaypair.ticket."

    /// Validates the server-supplied socket URL against the configured API host
    /// before connecting. A redirected socket would carry a live microphone to
    /// wherever the redirect pointed.
    static func request(for ticket: AiVoiceTicket, apiBaseURL: URL) throws -> URLRequest {
        let expectedScheme = apiBaseURL.scheme == "https" ? "wss" : "ws"
        guard
            ticket.ticket.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
            let components = URLComponents(url: ticket.webSocketUrl, resolvingAgainstBaseURL: false),
            components.scheme == expectedScheme,
            components.host?.lowercased() == apiBaseURL.host?.lowercased(),
            effectivePort(for: components.scheme, explicitPort: components.port)
                == effectivePort(for: apiBaseURL.scheme, explicitPort: apiBaseURL.port),
            components.path == "/v1/ai/voice",
            components.user == nil,
            components.password == nil,
            components.query == nil,
            components.fragment == nil
        else {
            throw APIError.invalidConfiguration
        }
        var request = URLRequest(url: ticket.webSocketUrl)
        request.setValue(
            "\(applicationProtocol), \(ticketProtocolPrefix)\(ticket.ticket)",
            forHTTPHeaderField: "Sec-WebSocket-Protocol"
        )
        return request
    }

    private static func effectivePort(for scheme: String?, explicitPort: Int?) -> Int? {
        explicitPort ?? (scheme == "https" || scheme == "wss" ? 443 : 80)
    }
}

/// What the server may ask of the interface mid-session.
struct VoiceToolConfirmation: Identifiable, Sendable, Equatable {
    let callId: String
    let name: String
    let title: String

    var id: String { callId }
}

enum VoiceClientEvent: Sendable, Equatable {
    case ready
    case transcript(text: String, final: Bool)
    case confirmationRequested(VoiceToolConfirmation)
    case toolSettled(callId: String, decision: String)
    case failed(reason: String)
    case closed(reason: String)
}

/// Decodes one server frame. Separated from the socket so the protocol can be
/// tested without one.
enum VoiceServerMessage {
    static func decode(_ raw: String) -> VoiceClientEvent? {
        guard
            let data = raw.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let type = object["type"] as? String
        else {
            return nil
        }
        switch type {
        case "ready":
            return .ready
        case "transcript":
            guard let text = object["text"] as? String else { return nil }
            return .transcript(text: text, final: object["final"] as? Bool ?? false)
        case "tool_confirmation":
            guard
                let callId = object["callId"] as? String,
                let name = object["name"] as? String
            else { return nil }
            return .confirmationRequested(
                VoiceToolConfirmation(
                    callId: callId,
                    name: name,
                    title: object["title"] as? String ?? name
                )
            )
        case "tool_result":
            guard
                let callId = object["callId"] as? String,
                let decision = object["decision"] as? String
            else { return nil }
            return .toolSettled(callId: callId, decision: decision)
        case "error":
            return .failed(reason: object["reason"] as? String ?? "unknown")
        case "closed":
            return .closed(reason: object["reason"] as? String ?? "closed")
        default:
            return nil
        }
    }
}

/// Captures the microphone, plays what comes back, and carries nothing else.
///
/// The engine is torn down on every stop rather than left idle, so "the session
/// ended" and "the microphone is off" cannot come apart.
actor VoiceClient {
    private let api: APIClient
    private let session: URLSession
    private let audio = VoiceAudioIO()

    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var continuation: AsyncStream<VoiceClientEvent>.Continuation?

    init(api: APIClient, session: URLSession = .shared) {
        self.api = api
        self.session = session
    }

    func events() -> AsyncStream<VoiceClientEvent> {
        AsyncStream { continuation in
            self.continuation?.finish()
            self.continuation = continuation
        }
    }

    /// Requests the microphone before anything opens. A refusal is a refusal:
    /// there is no session without it, and no silent partial mode.
    static func requestMicrophoneAccess() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }

    func start(ticket: AiVoiceTicket) async throws {
        guard socket == nil else { return }
        let base = await api.configuredBaseURL()
        let request = try VoiceHandshake.request(for: ticket, apiBaseURL: base)
        let task = session.webSocketTask(with: request)
        socket = task
        task.resume()
        receive()
        try await audio.start(sampleRate: Double(ticket.audio.sampleRateHz)) { [weak self] pcm in
            Task { await self?.send(pcm: pcm) }
        }
    }

    func confirm(callId: String) async {
        await sendJson(["type": "confirm", "callId": callId])
    }

    func decline(callId: String) async {
        await sendJson(["type": "decline", "callId": callId])
    }

    func stop() async {
        await audio.stop()
        await sendJson(["type": "end"])
        receiveTask?.cancel()
        receiveTask = nil
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        continuation?.finish()
        continuation = nil
    }

    /// True while the microphone tap is installed. The interface shows this
    /// rather than its own idea of whether a session is running.
    func isListening() async -> Bool {
        await audio.isRunning()
    }

    private func send(pcm: Data) async {
        guard let socket else { return }
        try? await socket.send(.data(pcm))
    }

    private func sendJson(_ payload: [String: String]) async {
        guard
            let socket,
            let data = try? JSONSerialization.data(withJSONObject: payload),
            let text = String(data: data, encoding: .utf8)
        else { return }
        try? await socket.send(.string(text))
    }

    private func receive() {
        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, let socket = await self.currentSocket() else { return }
                do {
                    let message = try await socket.receive()
                    await self.handle(message)
                } catch {
                    // A dropped socket ends the session rather than retrying:
                    // silently reconnecting a live microphone is not something
                    // to do on the user's behalf.
                    await self.emit(.closed(reason: "transport"))
                    await self.stop()
                    return
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) async {
        switch message {
        case .data(let data):
            await audio.play(data)
        case .string(let text):
            guard let event = VoiceServerMessage.decode(text) else { return }
            emit(event)
            if case .closed = event { await stop() }
        @unknown default:
            break
        }
    }

    private func currentSocket() -> URLSessionWebSocketTask? { socket }

    private func emit(_ event: VoiceClientEvent) {
        continuation?.yield(event)
    }
}

/// Supplies a captured buffer to `AVAudioConverter` exactly once.
///
/// The converter calls its input block synchronously during `convert`, so no
/// concurrent access is possible; the box makes that transfer explicit rather
/// than relaxing concurrency checking for all of AVFAudio.
private final class VoiceConverterFeed: @unchecked Sendable {
    private let buffer: AVAudioPCMBuffer
    private var supplied = false

    init(buffer: AVAudioPCMBuffer) {
        self.buffer = buffer
    }

    func next(status: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioPCMBuffer? {
        if supplied {
            status.pointee = .noDataNow
            return nil
        }
        supplied = true
        status.pointee = .haveData
        return buffer
    }
}

/// Microphone capture and playback at the server-stated format.
///
/// Capture is converted to 16 kHz mono PCM16 inside the tap callback and the
/// buffer is released there. The device knows its own hardware rate, and sending
/// a phone's native 48 kHz float stream would triple the bytes leaving the
/// device for no gain.
///
/// The engine is torn down on every stop rather than left idle, so "the session
/// ended" and "the microphone is off" cannot come apart.
actor VoiceAudioIO {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var playbackFormat: AVAudioFormat?
    private var running = false

    func isRunning() -> Bool { running }

    func start(sampleRate: Double, onFrame: @escaping @Sendable (Data) -> Void) async throws {
        guard !running else { return }

        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker])
        try audioSession.setActive(true)

        // The wire format is integer PCM; the mixer graph is float. Both are
        // named here so neither is inferred from the hardware.
        guard
            let wire = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: sampleRate,
                channels: 1,
                interleaved: true
            ),
            let playback = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)
        else {
            throw APIError.invalidConfiguration
        }
        playbackFormat = playback

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard
            inputFormat.sampleRate > 0,
            let converter = AVAudioConverter(from: inputFormat, to: wire)
        else {
            throw APIError.invalidConfiguration
        }

        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playback)

        input.installTap(onBus: 0, bufferSize: 2048, format: inputFormat) { buffer, _ in
            let frame = Self.encode(buffer, using: converter, target: wire)
            guard !frame.isEmpty else { return }
            onFrame(frame)
            // `buffer` goes out of scope here. Nothing retains it and nothing
            // writes it to disk.
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            engine.detach(player)
            throw error
        }
        player.play()
        running = true
    }

    func stop() {
        guard running else { return }
        running = false
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        engine.detach(player)
        // Deactivating releases the microphone indicator as well as the route.
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func play(_ pcm: Data) {
        guard running, let format = playbackFormat, pcm.count >= 2 else { return }
        let frames = AVAudioFrameCount(pcm.count / 2)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else {
            return
        }
        buffer.frameLength = frames
        guard let channel = buffer.floatChannelData?[0] else { return }
        pcm.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for index in 0..<Int(frames) {
                channel[index] = Float(samples[index]) / 32768
            }
        }
        player.scheduleBuffer(buffer, completionHandler: nil)
    }

    /// Runs on the audio thread, synchronously, and returns bytes rather than a
    /// buffer so nothing non-Sendable leaves the callback.
    nonisolated private static func encode(
        _ buffer: AVAudioPCMBuffer,
        using converter: AVAudioConverter,
        target: AVAudioFormat
    ) -> Data {
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
            return Data()
        }

        let feed = VoiceConverterFeed(buffer: buffer)
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            feed.next(status: status)
        }
        guard error == nil, output.frameLength > 0, let channel = output.int16ChannelData else {
            return Data()
        }
        return Data(bytes: channel[0], count: Int(output.frameLength) * 2)
    }
}

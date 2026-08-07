import Foundation

enum RealtimeHandshake {
    static let applicationProtocol = "rafaypair.v1"
    static let ticketProtocolPrefix = "rafaypair.ticket."

    static func request(for ticket: RealtimeTicket, apiBaseURL: URL) throws -> URLRequest {
        let expectedScheme = apiBaseURL.scheme == "https" ? "wss" : "ws"
        guard
            ticket.ticket.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
            let components = URLComponents(url: ticket.webSocketUrl, resolvingAgainstBaseURL: false),
            components.scheme == expectedScheme,
            components.host?.lowercased() == apiBaseURL.host?.lowercased(),
            effectivePort(for: components.scheme, explicitPort: components.port)
                == effectivePort(for: apiBaseURL.scheme, explicitPort: apiBaseURL.port),
            components.path == "/v1/realtime",
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

enum RealtimeConnectionState: Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case reconnecting(attempt: Int)
}

enum RealtimeClientEvent: Sendable {
    case careChanged
    case pairDisconnected
    case privacyPaused
    case connection(RealtimeConnectionState)
}

actor RealtimeClient {
    private let api: APIClient
    private let session: URLSession
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var continuation: AsyncStream<RealtimeClientEvent>.Continuation?
    private var continuationID: UUID?
    private var reconnectAttempt = 0
    private var lastEventID: String?
    private var intentionallyStopped = true

    init(api: APIClient, session: URLSession = .shared) {
        self.api = api
        self.session = session
    }

    func events() -> AsyncStream<RealtimeClientEvent> {
        let streamID = UUID()
        return AsyncStream { continuation in
            self.continuation?.finish()
            self.continuation = continuation
            self.continuationID = streamID
            continuation.onTermination = { [weak self] _ in
                Task { await self?.streamTerminated(streamID) }
            }
        }
    }

    func start() async {
        guard socket == nil else { return }
        intentionallyStopped = false
        await connect()
    }

    func stop() {
        intentionallyStopped = true
        receiveTask?.cancel()
        receiveTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        continuation?.yield(.connection(.disconnected))
    }

    func resetAccountState() {
        stop()
        lastEventID = nil
        reconnectAttempt = 0
        continuationID = nil
        continuation?.finish()
        continuation = nil
    }

    private func streamTerminated(_ streamID: UUID) {
        guard continuationID == streamID else { return }
        continuationID = nil
        continuation = nil
        stop()
    }

    private func connect() async {
        continuation?.yield(.connection(reconnectAttempt == 0 ? .connecting : .reconnecting(attempt: reconnectAttempt)))
        do {
            let ticket: RealtimeTicket = try await api.authenticated(
                "/v1/realtime/tickets",
                method: .post,
                body: RealtimeTicketRequest(lastEventId: lastEventID)
            )
            let apiBaseURL = await api.configuredBaseURL()
            let request = try RealtimeHandshake.request(for: ticket, apiBaseURL: apiBaseURL)
            let task = session.webSocketTask(with: request)
            socket = task
            task.resume()
            reconnectAttempt = 0
            continuation?.yield(.connection(.connected))
            receiveTask = Task { [weak self] in
                await self?.receiveLoop(task)
            }
        } catch {
            await scheduleReconnect()
        }
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask) async {
        do {
            while !Task.isCancelled {
                let message = try await task.receive()
                let data: Data
                switch message {
                case .data(let value): data = value
                case .string(let value): data = Data(value.utf8)
                @unknown default: continue
                }
                try consume(data)
            }
        } catch {
            socket = nil
            if !intentionallyStopped { await scheduleReconnect() }
        }
    }

    private func consume(_ data: Data) throws {
        struct Header: Decodable {
            let eventId: String
            let type: String
        }
        let header = try JSONDecoder.rafayPair.decode(Header.self, from: data)
        lastEventID = header.eventId
        switch header.type {
        case "care.request.created", "care.request.responded": continuation?.yield(.careChanged)
        case "pair.disconnected": continuation?.yield(.pairDisconnected)
        case "privacy.paused": continuation?.yield(.privacyPaused)
        default: break
        }
    }

    private func scheduleReconnect() async {
        guard !intentionallyStopped else { return }
        reconnectAttempt += 1
        continuation?.yield(.connection(.reconnecting(attempt: reconnectAttempt)))
        let seconds = min(pow(2.0, Double(reconnectAttempt - 1)), 30.0)
        try? await Task.sleep(for: .seconds(seconds))
        guard !intentionallyStopped else { return }
        await connect()
    }
}

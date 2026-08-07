import Foundation

enum HTTPMethod: String, Sendable {
    case get = "GET"
    case post = "POST"
    case put = "PUT"
    case delete = "DELETE"
}

actor APIClient {
    private let baseURL: URL
    private let session: URLSession
    private let tokenVault: TokenVault
    private var refreshTask: Task<TokenPair, Error>?

    init(baseURL: URL, session: URLSession = .shared, tokenVault: TokenVault) {
        self.baseURL = baseURL
        self.session = session
        self.tokenVault = tokenVault
    }

    func configuredBaseURL() -> URL {
        baseURL
    }

    func unauthenticated<Response: Decodable & Sendable, Body: Encodable & Sendable>(
        _ path: String,
        method: HTTPMethod,
        body: Body
    ) async throws -> Response {
        try await perform(path, method: method, body: try JSONEncoder.rafayPair.encode(body), accessToken: nil)
    }

    func unauthenticatedVoid<Body: Encodable & Sendable>(
        _ path: String,
        method: HTTPMethod,
        body: Body
    ) async throws {
        let _: EmptyResponse = try await perform(
            path,
            method: method,
            body: try JSONEncoder.rafayPair.encode(body),
            accessToken: nil
        )
    }

    func authenticated<Response: Decodable & Sendable, Body: Encodable & Sendable>(
        _ path: String,
        method: HTTPMethod,
        body: Body
    ) async throws -> Response {
        try await authenticated(path, method: method, data: try JSONEncoder.rafayPair.encode(body))
    }

    func authenticated<Response: Decodable & Sendable>(
        _ path: String,
        method: HTTPMethod = .get
    ) async throws -> Response {
        try await authenticated(path, method: method, data: nil)
    }

    func authenticatedVoid<Body: Encodable & Sendable>(
        _ path: String,
        method: HTTPMethod,
        body: Body
    ) async throws {
        let _: EmptyResponse = try await authenticated(
            path, method: method, data: try JSONEncoder.rafayPair.encode(body))
    }

    func authenticatedVoid(_ path: String, method: HTTPMethod) async throws {
        let _: EmptyResponse = try await authenticated(path, method: method, data: nil)
    }

    private func authenticated<Response: Decodable & Sendable>(
        _ path: String,
        method: HTTPMethod,
        data: Data?
    ) async throws -> Response {
        guard let tokens = try await tokenVault.load() else { throw APIError.notAuthenticated }
        do {
            return try await perform(path, method: method, body: data, accessToken: tokens.accessToken)
        } catch APIError.server(let problem) where problem.status == 401 {
            let refreshed = try await refresh(using: tokens.refreshToken)
            return try await perform(path, method: method, body: data, accessToken: refreshed.accessToken)
        }
    }

    private func refresh(using refreshToken: String) async throws -> TokenPair {
        if let refreshTask { return try await refreshTask.value }

        let task = Task<TokenPair, Error> {
            let request = RefreshRequest(refreshToken: refreshToken)
            let response: AuthResponse = try await self.perform(
                "/v1/auth/refresh",
                method: .post,
                body: try JSONEncoder.rafayPair.encode(request),
                accessToken: nil
            )
            try await self.tokenVault.save(response.session)
            return response.session
        }
        refreshTask = task
        defer { refreshTask = nil }

        do {
            return try await task.value
        } catch {
            try? await tokenVault.clear()
            throw APIError.notAuthenticated
        }
    }

    private func perform<Response: Decodable & Sendable>(
        _ path: String,
        method: HTTPMethod,
        body: Data?,
        accessToken: String?
    ) async throws -> Response {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw APIError.invalidConfiguration
        }

        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue
        request.httpBody = body
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("ios", forHTTPHeaderField: "X-Rafay-Client")
        request.setValue(UUID().uuidString, forHTTPHeaderField: "X-Request-ID")
        if let accessToken {
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            if let problem = try? JSONDecoder.rafayPair.decode(ProblemDetails.self, from: data) {
                throw APIError.server(problem)
            }
            throw APIError.server(
                ProblemDetails(
                    type: nil,
                    title: HTTPURLResponse.localizedString(forStatusCode: http.statusCode),
                    status: http.statusCode,
                    detail: nil,
                    instance: nil,
                    code: nil
                )
            )
        }

        if Response.self == EmptyResponse.self, data.isEmpty {
            guard let empty = EmptyResponse() as? Response else { throw APIError.invalidResponse }
            return empty
        }

        do {
            return try JSONDecoder.rafayPair.decode(Response.self, from: data)
        } catch {
            throw APIError.decoding(error.localizedDescription)
        }
    }
}

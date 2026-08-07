import Foundation

enum APIError: LocalizedError, Equatable, Sendable {
    case invalidConfiguration
    case invalidResponse
    case notAuthenticated
    case transport(String)
    case server(ProblemDetails)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .invalidConfiguration:
            "RafayPair is not configured with a valid secure API address."
        case .invalidResponse:
            "The server returned an invalid response."
        case .notAuthenticated:
            "Please sign in again."
        case .transport(let message):
            "The network request failed: \(message)"
        case .server(let problem):
            problem.detail ?? problem.title
        case .decoding:
            "RafayPair could not understand the server response."
        }
    }
}

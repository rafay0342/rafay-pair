import XCTest

@testable import RafayPair

/// The voice socket's handshake and wire protocol.
///
/// Both are checked here rather than only against a running server, because the
/// failures they prevent — a microphone opened against the wrong host, a tool
/// confirmation misread — are not the kind that surface as a test flake.
final class VoiceClientTests: XCTestCase {
    private let base = URL(string: "https://api.example.test")!

    private func ticket(
        url: String,
        value: String = String(repeating: "a", count: 43)
    ) -> AiVoiceTicket {
        AiVoiceTicket(
            ticket: value,
            expiresAt: Date().addingTimeInterval(30),
            webSocketUrl: URL(string: url)!,
            audio: AiVoiceAudioFormat(
                encoding: "pcm16",
                sampleRateHz: 16_000,
                outputSampleRateHz: 24_000,
                channels: 1
            )
        )
    }

    func testCarriesTheTicketInTheProtocolHeaderRatherThanTheURL() throws {
        let request = try VoiceHandshake.request(
            for: ticket(url: "wss://api.example.test/v1/ai/voice"),
            apiBaseURL: base
        )
        let header = request.value(forHTTPHeaderField: "Sec-WebSocket-Protocol")
        XCTAssertEqual(
            header,
            "rafaypair.voice.v1, rafaypair.ticket.\(String(repeating: "a", count: 43))"
        )
        // A credential in the query string ends up in every proxy log on the path.
        XCTAssertNil(request.url?.query)
    }

    func testRefusesASocketThatIsNotTheConfiguredAPI() {
        // A redirected socket would carry a live microphone wherever it pointed.
        for url in [
            "wss://elsewhere.example.test/v1/ai/voice",
            "ws://api.example.test/v1/ai/voice",
            "wss://api.example.test:8443/v1/ai/voice",
            "wss://api.example.test/v1/realtime",
            "wss://api.example.test/v1/ai/voice?ticket=leak",
            "wss://user:pass@api.example.test/v1/ai/voice",
        ] {
            XCTAssertThrowsError(
                try VoiceHandshake.request(for: ticket(url: url), apiBaseURL: base),
                url
            )
        }
    }

    func testRefusesATicketOfTheWrongShape() {
        for value in ["", "short", String(repeating: "a", count: 44), "has spaces!!"] {
            XCTAssertThrowsError(
                try VoiceHandshake.request(
                    for: ticket(url: "wss://api.example.test/v1/ai/voice", value: value),
                    apiBaseURL: base
                ),
                value
            )
        }
    }

    func testDecodesTheServerFramesTheProtocolDefines() {
        XCTAssertEqual(VoiceServerMessage.decode(#"{"type":"ready"}"#), .ready)
        XCTAssertEqual(
            VoiceServerMessage.decode(#"{"type":"transcript","text":"hello","final":true}"#),
            .transcript(text: "hello", final: true)
        )
        XCTAssertEqual(
            VoiceServerMessage.decode(
                #"{"type":"tool_confirmation","callId":"c1","name":"remember","title":"Save it"}"#
            ),
            .confirmationRequested(
                VoiceToolConfirmation(callId: "c1", name: "remember", title: "Save it")
            )
        )
        XCTAssertEqual(
            VoiceServerMessage.decode(#"{"type":"tool_result","callId":"c1","decision":"executed"}"#),
            .toolSettled(callId: "c1", decision: "executed")
        )
        XCTAssertEqual(
            VoiceServerMessage.decode(#"{"type":"closed","reason":"user_ended"}"#),
            .closed(reason: "user_ended")
        )
    }

    func testIgnoresFramesItDoesNotUnderstand() {
        // Including a confirmation without a call id: acting on one would mean
        // prompting the user to authorize something unidentifiable.
        for raw in [
            "not json",
            #"{"type":"tool_confirmation","name":"remember"}"#,
            #"{"type":"transcript","final":true}"#,
            #"{"type":"execute","name":"remember"}"#,
            "[]",
        ] {
            XCTAssertNil(VoiceServerMessage.decode(raw), raw)
        }
    }
}

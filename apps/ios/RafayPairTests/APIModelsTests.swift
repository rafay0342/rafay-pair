import XCTest

@testable import RafayPair

final class APIModelsTests: XCTestCase {
    func testTokenPairDecodesRFC3339FractionalSeconds() throws {
        let json = Data(
            """
            {
              "accessToken": "access",
              "refreshToken": "refresh",
              "accessTokenExpiresAt": "2026-08-07T07:15:20.123Z",
              "refreshTokenExpiresAt": "2026-09-06T07:15:20Z"
            }
            """.utf8
        )

        let tokens = try JSONDecoder.rafayPair.decode(TokenPair.self, from: json)

        XCTAssertEqual(tokens.accessToken, "access")
        XCTAssertGreaterThan(tokens.refreshTokenExpiresAt, tokens.accessTokenExpiresAt)
    }

    func testEveryConsentScopeExplainsTheSharedData() {
        XCTAssertEqual(Set(ConsentScope.allCases.map(\.rawValue)).count, ConsentScope.allCases.count)
        XCTAssertTrue(ConsentScope.allCases.allSatisfy { !$0.title.isEmpty && !$0.explanation.isEmpty })
    }

    func testCareRequestKindsHaveStableUniqueIdentifiers() {
        XCTAssertEqual(Set(CareRequestKind.allCases.map(\.id)).count, CareRequestKind.allCases.count)
    }

    func testMilestoneOneWrappedResponsesDecodeFromOpenAPIShapes() throws {
        let pair = try decode(
            PairResponse.self,
            """
            {
              "pair": {
                "id": "00000000-0000-4000-8000-000000000010",
                "status": "waiting",
                "members": [{
                  "userId": "00000000-0000-4000-8000-000000000001",
                  "displayName": "Rafay",
                  "joinedAt": "2026-08-07T07:15:20Z"
                }],
                "joinCode": "ABCD2345",
                "createdAt": "2026-08-07T07:15:20Z"
              }
            }
            """
        )
        XCTAssertEqual(pair.pair.status, .waiting)
        XCTAssertEqual(pair.pair.members.first?.displayName, "Rafay")

        let consents = try decode(
            ConsentListResponse.self,
            """
            {
              "pairId": "00000000-0000-4000-8000-000000000010",
              "grantorUserId": "00000000-0000-4000-8000-000000000001",
              "granteeUserId": "00000000-0000-4000-8000-000000000002",
              "grants": [{
                "capability": "care_requests",
                "granted": false,
                "updatedAt": "2026-08-07T07:15:20Z"
              }]
            }
            """
        )
        XCTAssertEqual(consents.grants.first?.capability, .careRequests)
        XCTAssertEqual(consents.grants.first?.granted, false)

        let care = try decode(
            CareRequestResponse.self,
            """
            {
              "careRequest": {
                "id": "00000000-0000-4000-8000-000000000020",
                "clientRequestId": "00000000-0000-4000-8000-000000000021",
                "pairId": "00000000-0000-4000-8000-000000000010",
                "senderUserId": "00000000-0000-4000-8000-000000000001",
                "recipientUserId": "00000000-0000-4000-8000-000000000002",
                "kind": "help",
                "message": "Please call when you can.",
                "status": "pending",
                "createdAt": "2026-08-07T07:15:20Z"
              }
            }
            """
        )
        XCTAssertEqual(care.careRequest.kind, .help)

        let privacy = try decode(
            PrivacyStateResponse.self,
            """
            {
              "privacy": {
                "pairId": "00000000-0000-4000-8000-000000000010",
                "userId": "00000000-0000-4000-8000-000000000001",
                "paused": true,
                "pausedAt": "2026-08-07T07:15:20Z",
                "updatedAt": "2026-08-07T07:15:20Z"
              }
            }
            """
        )
        XCTAssertTrue(privacy.privacy.paused)

        let ticket = try decode(
            RealtimeTicket.self,
            """
            {
              "ticket": "abcdefghijklmnopqrstuvwxyzABCDEFGH123456789",
              "expiresAt": "2026-08-07T07:15:50Z",
              "webSocketUrl": "wss://api.rafaypair.com/v1/realtime"
            }
            """
        )
        XCTAssertEqual(ticket.webSocketUrl.host, "api.rafaypair.com")
        let realtimeRequest = try RealtimeHandshake.request(
            for: ticket,
            apiBaseURL: try XCTUnwrap(URL(string: "https://api.rafaypair.com"))
        )
        XCTAssertNil(realtimeRequest.url?.query)
        XCTAssertEqual(
            realtimeRequest.value(forHTTPHeaderField: "Sec-WebSocket-Protocol"),
            "rafaypair.v1, rafaypair.ticket.abcdefghijklmnopqrstuvwxyzABCDEFGH123456789"
        )
        let untrustedTicket = RealtimeTicket(
            ticket: ticket.ticket,
            expiresAt: ticket.expiresAt,
            webSocketUrl: try XCTUnwrap(URL(string: "wss://attacker.example/v1/realtime"))
        )
        XCTAssertThrowsError(
            try RealtimeHandshake.request(
                for: untrustedTicket,
                apiBaseURL: try XCTUnwrap(URL(string: "https://api.rafaypair.com"))
            )
        )
    }

    func testMutationPayloadsUseCanonicalCamelCaseFields() throws {
        let clientRequestId = try XCTUnwrap(UUID(uuidString: "00000000-0000-4000-8000-000000000021"))
        let request = CreateCareRequest(
            clientRequestId: clientRequestId,
            kind: .checkIn,
            message: "How are you?"
        )
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder.rafayPair.encode(request)) as? [String: Any]
        )
        XCTAssertNotNil(object["clientRequestId"])
        XCTAssertNil(object["client_request_id"])
        XCTAssertEqual(object["message"] as? String, "How are you?")
    }

    func testNotificationDeviceRegistrationUsesStableInstallationContract() throws {
        let installationID = try XCTUnwrap(
            UUID(uuidString: "00000000-0000-4000-8000-000000000099")
        )
        let request = RegisterNotificationDeviceRequest(
            platform: .ios,
            token: String(repeating: "ab", count: 32),
            installationId: installationID
        )
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder.rafayPair.encode(request)) as? [String: Any]
        )

        XCTAssertEqual(object["platform"] as? String, "ios")
        XCTAssertEqual(object["installationId"] as? String, installationID.uuidString.uppercased())
        XCTAssertNil(object["installation_id"])
    }

    private func decode<Value: Decodable>(_ type: Value.Type, _ json: String) throws -> Value {
        try JSONDecoder.rafayPair.decode(type, from: Data(json.utf8))
    }
}

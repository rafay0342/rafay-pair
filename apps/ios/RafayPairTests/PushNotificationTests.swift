import XCTest

@testable import RafayPair

final class PushNotificationTests: XCTestCase {
    func testOnlyContentAvailableWakeIsAccepted() {
        XCTAssertTrue(
            PushApplicationDelegate.isContentAvailableWake([
                "aps": ["content-available": 1]
            ])
        )
        XCTAssertFalse(
            PushApplicationDelegate.isContentAvailableWake([
                "aps": ["alert": "Untrusted content"]
            ])
        )
        XCTAssertFalse(
            PushApplicationDelegate.isContentAvailableWake([
                "aps": ["content-available": 1, "alert": "Untrusted content"]
            ])
        )
        XCTAssertFalse(PushApplicationDelegate.isContentAvailableWake(["sync": "care"]))
    }

    func testCareNotificationRequiresNewPendingRequestForCurrentRecipient() throws {
        let currentUser = try XCTUnwrap(UUID(uuidString: "00000000-0000-4000-8000-000000000001"))
        let otherUser = try XCTUnwrap(UUID(uuidString: "00000000-0000-4000-8000-000000000002"))
        let existingID = try XCTUnwrap(UUID(uuidString: "00000000-0000-4000-8000-000000000011"))
        let newID = try XCTUnwrap(UUID(uuidString: "00000000-0000-4000-8000-000000000012"))
        let ignoredID = try XCTUnwrap(UUID(uuidString: "00000000-0000-4000-8000-000000000013"))
        let requests = [
            careRequest(id: existingID, recipient: currentUser, status: .pending, offset: 1),
            careRequest(id: newID, recipient: currentUser, status: .pending, offset: 2),
            careRequest(id: ignoredID, recipient: otherUser, status: .pending, offset: 3),
            careRequest(id: UUID(), recipient: currentUser, status: .accepted, offset: 4),
        ]

        let current = CareNotificationPolicy.pendingIncomingIDs(
            in: requests,
            currentUserID: currentUser
        )
        XCTAssertEqual(current, [newID, existingID])
        XCTAssertEqual(
            CareNotificationPolicy.unseenIDs(current: current, seen: [existingID]),
            [newID]
        )
    }

    func testAPNSTokenValidationRejectsNonHexOrTruncatedValues() {
        XCTAssertTrue(PushTokenPolicy.isValid(String(repeating: "a1", count: 32)))
        XCTAssertFalse(PushTokenPolicy.isValid("short"))
        XCTAssertFalse(PushTokenPolicy.isValid(String(repeating: "z", count: 64)))
    }

    private func careRequest(
        id: UUID,
        recipient: UUID,
        status: CareRequestStatus,
        offset: TimeInterval
    ) -> CareRequest {
        CareRequest(
            id: id,
            clientRequestId: UUID(),
            pairId: UUID(),
            senderUserId: UUID(),
            recipientUserId: recipient,
            kind: .checkIn,
            message: nil,
            status: status,
            createdAt: Date(timeIntervalSince1970: offset),
            respondedAt: nil
        )
    }
}

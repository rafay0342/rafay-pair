import Foundation
import SwiftData

@Model
final class CareDraft {
    @Attribute(.unique) var id: UUID
    var ownerUserID: UUID?
    var pairID: UUID?
    var kindRawValue: String
    var note: String
    var createdAt: Date
    var modifiedAt: Date
    var deliveryStateRawValue: String = CareDraftDeliveryState.draft.rawValue
    var attemptCount: Int = 0
    var lastAttemptAt: Date?
    var lastError: String?

    init(
        id: UUID = UUID(),
        ownerUserID: UUID,
        pairID: UUID,
        kind: CareRequestKind = .checkIn,
        note: String = ""
    ) {
        self.id = id
        self.ownerUserID = ownerUserID
        self.pairID = pairID
        kindRawValue = kind.rawValue
        self.note = note
        createdAt = Date()
        modifiedAt = Date()
    }

    var kind: CareRequestKind {
        get { CareRequestKind(rawValue: kindRawValue) ?? .checkIn }
        set {
            kindRawValue = newValue.rawValue
            modifiedAt = Date()
        }
    }

    var deliveryState: CareDraftDeliveryState {
        get { CareDraftDeliveryState(rawValue: deliveryStateRawValue) ?? .draft }
        set {
            deliveryStateRawValue = newValue.rawValue
            modifiedAt = Date()
        }
    }

    var isEligibleForRetry: Bool {
        guard deliveryState == .queued else { return false }
        guard let lastAttemptAt else { return true }
        let delay = min(pow(2.0, Double(max(attemptCount - 1, 0))), 300)
        return Date().timeIntervalSince(lastAttemptAt) >= delay
    }

    func recordQueuedFailure(_ message: String?) {
        deliveryState = .queued
        attemptCount += 1
        lastAttemptAt = Date()
        lastError = message
    }

    func requireReview(_ message: String) {
        deliveryState = .draft
        lastError = message
        lastAttemptAt = Date()
    }
}

enum CareDraftDeliveryState: String, Codable, Sendable {
    case draft
    case queued
}

@MainActor
enum CareDraftPersistence {
    static func clearAccounts(except retainedOwnerID: UUID?, in context: ModelContext) throws {
        let drafts = try context.fetch(FetchDescriptor<CareDraft>())
        for draft in drafts
        where retainedOwnerID == nil || draft.ownerUserID == nil || draft.ownerUserID != retainedOwnerID {
            context.delete(draft)
        }
        try context.save()
    }

    static func clearOutsidePair(
        ownerUserID: UUID,
        retainedPairID: UUID?,
        in context: ModelContext
    ) throws {
        let drafts = try context.fetch(FetchDescriptor<CareDraft>())
        for draft in drafts where draft.ownerUserID == ownerUserID && draft.pairID != retainedPairID {
            context.delete(draft)
        }
        try context.save()
    }

    static func clear(ownerUserID: UUID, pairID: UUID, in context: ModelContext) throws {
        let drafts = try context.fetch(FetchDescriptor<CareDraft>())
        for draft in drafts where draft.ownerUserID == ownerUserID && draft.pairID == pairID {
            context.delete(draft)
        }
        try context.save()
    }
}

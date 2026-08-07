import { z } from "zod";

export const eventContractVersion = 1 as const;

export const domainEventTypeSchema = z.enum([
  "care.request.created",
  "care.request.responded",
  "consent.changed",
  "privacy.paused",
  "privacy.resumed",
  "pair.disconnected",
  "pulse.snapshot.shared",
]);

export const domainEventSchema = z.object({
  version: z.literal(eventContractVersion),
  id: z.string().uuid(),
  type: domainEventTypeSchema,
  aggregateType: z.enum([
    "pair",
    "care_request",
    "consent",
    "privacy",
    "pulse",
  ]),
  aggregateId: z.string().uuid(),
  pairId: z.string().uuid(),
  actorUserId: z.string().uuid(),
  recipientUserId: z.string().uuid().optional(),
  occurredAt: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()),
});

export type DomainEventType = z.infer<typeof domainEventTypeSchema>;
export type DomainEvent = z.infer<typeof domainEventSchema>;

export interface DirectionalConsentRequirement {
  readonly capability: "care_requests" | "pulse_snapshots";
  readonly grantorUserId: string;
  readonly granteeUserId: string;
}

/**
 * Maps partner-visible events to the directional grant which authorized the
 * underlying action. Revocation control events intentionally return null so
 * they can propagate after consent or pair state has been removed.
 */
export function directionalConsentForEvent(input: {
  readonly type: DomainEventType;
  readonly actorUserId: string;
  readonly recipientUserId?: string;
}): DirectionalConsentRequirement | null {
  if (input.type === "pulse.snapshot.shared") {
    // The owner of the reading is the grantor: they decide whether their
    // partner may see it. Delivery re-checks this, so revoking consent stops an
    // already-queued snapshot from reaching the partner.
    if (!input.recipientUserId) return null;
    return {
      capability: "pulse_snapshots",
      grantorUserId: input.actorUserId,
      granteeUserId: input.recipientUserId,
    };
  }
  if (
    input.type !== "care.request.created" &&
    input.type !== "care.request.responded"
  ) {
    return null;
  }
  if (!input.recipientUserId) return null;
  return input.type === "care.request.created"
    ? {
        capability: "care_requests",
        grantorUserId: input.recipientUserId,
        granteeUserId: input.actorUserId,
      }
    : {
        capability: "care_requests",
        grantorUserId: input.actorUserId,
        granteeUserId: input.recipientUserId,
      };
}

export function createDomainEvent(
  input: Omit<DomainEvent, "version" | "id" | "occurredAt"> &
    Partial<Pick<DomainEvent, "id" | "occurredAt">>,
): DomainEvent {
  return domainEventSchema.parse({
    ...input,
    version: eventContractVersion,
    id: input.id ?? crypto.randomUUID(),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  });
}

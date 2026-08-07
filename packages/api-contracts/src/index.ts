import { z } from "zod";

export const apiVersion = "1.0.0" as const;

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z
  .string()
  .min(12)
  .max(128)
  .refine((value) => /[A-Za-z]/.test(value) && /\d/.test(value), {
    message: "Password must contain at least one letter and one number",
  });
export const displayNameSchema = z.string().trim().min(1).max(80);

export const userSchema = z.object({
  id: z.string().uuid(),
  email: emailSchema,
  displayName: displayNameSchema,
  createdAt: z.string().datetime(),
});

export const registerRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
});

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(32).max(512).optional(),
});

export const logoutRequestSchema = refreshRequestSchema;

export const sessionSchema = z.object({
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  accessTokenExpiresAt: z.string().datetime(),
  refreshTokenExpiresAt: z.string().datetime(),
});

export const authResponseSchema = z.object({
  user: userSchema,
  session: sessionSchema,
});

export const pairMemberSchema = z.object({
  userId: z.string().uuid(),
  displayName: displayNameSchema,
  joinedAt: z.string().datetime(),
});

export const pairSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["waiting", "active"]),
  members: z.array(pairMemberSchema).min(1).max(2),
  joinCode: z
    .string()
    .regex(/^[A-Z2-9]{8}$/)
    .optional(),
  createdAt: z.string().datetime(),
});

export const pairResponseSchema = z.object({ pair: pairSchema });
export const joinPairRequestSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z2-9]{8}$/),
});

export const consentCapabilitySchema = z.enum([
  "care_requests",
  "presence",
  "workout_progress",
  "pulse_snapshots",
  "breathing_state",
  "estimated_calories",
  "ai_partner_context",
]);

export const consentGrantSchema = z.object({
  capability: consentCapabilitySchema,
  granted: z.boolean(),
  updatedAt: z.string().datetime(),
});

export const consentResponseSchema = z.object({
  pairId: z.string().uuid(),
  grantorUserId: z.string().uuid(),
  granteeUserId: z.string().uuid(),
  grants: z.array(consentGrantSchema),
});

export const updateConsentsRequestSchema = z.object({
  grants: z
    .array(
      z.object({
        capability: consentCapabilitySchema,
        granted: z.boolean(),
      }),
    )
    .min(1)
    .max(consentCapabilitySchema.options.length)
    .refine(
      (grants) =>
        new Set(grants.map(({ capability }) => capability)).size ===
        grants.length,
      { message: "Each consent capability may appear only once" },
    ),
});

export const careRequestKindSchema = z.enum([
  "check_in",
  "encouragement",
  "breathe_together",
  "move_together",
  "help",
  "call_me",
]);
export const careRequestStatusSchema = z.enum([
  "pending",
  "accepted",
  "declined",
  "expired",
]);
export const careResponseSchema = z.enum(["accepted", "declined"]);

export const createCareRequestSchema = z.object({
  clientRequestId: z.string().uuid(),
  kind: careRequestKindSchema,
  message: z.string().trim().min(1).max(500).optional(),
});

export const respondCareRequestSchema = z.object({
  response: careResponseSchema,
});

export const careRequestSchema = z.object({
  id: z.string().uuid(),
  clientRequestId: z.string().uuid(),
  pairId: z.string().uuid(),
  senderUserId: z.string().uuid(),
  recipientUserId: z.string().uuid(),
  kind: careRequestKindSchema,
  message: z.string().optional(),
  status: careRequestStatusSchema,
  createdAt: z.string().datetime(),
  respondedAt: z.string().datetime().optional(),
});

export const careRequestResponseSchema = z.object({
  careRequest: careRequestSchema,
});
export const careRequestListResponseSchema = z.object({
  items: z.array(careRequestSchema),
  nextCursor: z.string().optional(),
});

export const careRequestCursorSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

export const careRequestListQuerySchema = z.object({
  cursor: careRequestCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const privacyStateSchema = z.object({
  pairId: z.string().uuid(),
  userId: z.string().uuid(),
  paused: z.boolean(),
  pausedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime(),
});

export const privacyStateResponseSchema = z.object({
  privacy: privacyStateSchema,
});

export const realtimeCursorSchema = z
  .string()
  .max(19)
  .regex(/^\d+$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n, {
    message: "Cursor exceeds PostgreSQL signed bigint range",
  });

export const realtimeTicketRequestSchema = z.object({
  lastEventId: realtimeCursorSchema.optional(),
});

export const realtimeApplicationProtocol = "rafaypair.v1" as const;
export const realtimeTicketProtocolPrefix = "rafaypair.ticket." as const;
export const realtimeTicketSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export function realtimeWebSocketProtocols(
  ticket: string,
): readonly [typeof realtimeApplicationProtocol, string] {
  const validated = realtimeTicketSchema.parse(ticket);
  return [
    realtimeApplicationProtocol,
    `${realtimeTicketProtocolPrefix}${validated}`,
  ];
}

export const realtimeTicketResponseSchema = z.object({
  ticket: realtimeTicketSchema,
  expiresAt: z.string().datetime(),
  webSocketUrl: z.string(),
});

export const realtimeEventEnvelopeSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  eventId: realtimeCursorSchema,
  authorizationRevision: realtimeCursorSchema,
  type: z.enum([
    "care.request.created",
    "care.request.responded",
    "privacy.paused",
    "privacy.resumed",
    "pair.disconnected",
  ]),
  occurredAt: z.string().datetime(),
  pairId: z.string().uuid(),
  payload: z.record(z.string(), z.unknown()),
});

export const notificationPlatformSchema = z.enum(["ios", "android", "web"]);
export const registerNotificationDeviceSchema = z.object({
  platform: z.enum(["ios", "android"]),
  installationId: z.string().uuid(),
  token: z.string().trim().min(16).max(4096),
});

export const androidIntegrityActionSchema = z.enum(["session_start"]);
export const androidIntegrityBindingVersion = "sha256-v1" as const;

export const createAndroidIntegrityChallengeSchema = z.object({
  action: androidIntegrityActionSchema,
});

export const androidIntegrityChallengeResponseSchema = z.object({
  challenge: z.object({
    id: z.string().uuid(),
    action: androidIntegrityActionSchema,
    bindingVersion: z.literal(androidIntegrityBindingVersion),
    expiresAt: z.string().datetime(),
  }),
});

export const submitAndroidIntegrityAssessmentSchema = z.object({
  challengeId: z.string().uuid(),
  action: androidIntegrityActionSchema,
  integrityToken: z.string().min(64).max(60_000).regex(/^\S+$/u),
});

export const androidIntegrityAssessmentResponseSchema = z.object({
  assessment: z.object({
    id: z.string().uuid(),
    signal: z.enum(["low_risk", "elevated_risk", "invalid_binding"]),
    evaluatedAt: z.string().datetime(),
  }),
});

export const iosIntegrityActionSchema = z.enum(["session_start"]);
export const appAttestBindingVersion = "app-attest-sha256-v1" as const;
export const appAttestModeSchema = z.enum([
  "attestation",
  "assertion",
  "unsupported",
]);
export const appAttestKeyIdSchema = z
  .string()
  .length(44)
  .regex(/^[A-Za-z0-9+/]{43}=$/u);

export const createIosIntegrityChallengeSchema = z
  .object({
    action: iosIntegrityActionSchema,
    supported: z.boolean(),
    keyId: appAttestKeyIdSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.supported !== (value.keyId !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["keyId"],
        message: value.supported
          ? "keyId is required when App Attest is supported"
          : "keyId must be omitted when App Attest is unsupported",
      });
    }
  });

export const iosIntegrityChallengeResponseSchema = z.object({
  challenge: z.object({
    id: z.string().uuid(),
    action: iosIntegrityActionSchema,
    mode: appAttestModeSchema,
    bindingVersion: z.literal(appAttestBindingVersion),
    clientData: z
      .string()
      .min(64)
      .max(1_024)
      .regex(/^[A-Za-z0-9_-]+$/u),
    expiresAt: z.string().datetime(),
  }),
});

const appAttestBaseSubmissionSchema = z
  .object({
    challengeId: z.string().uuid(),
    action: iosIntegrityActionSchema,
  })
  .strict();
const standardBase64Schema = z
  .string()
  .min(1)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);

export const submitIosIntegrityAssessmentSchema = z.discriminatedUnion("mode", [
  appAttestBaseSubmissionSchema.extend({
    mode: z.literal("attestation"),
    keyId: appAttestKeyIdSchema,
    attestationObject: standardBase64Schema.max(90_000),
  }),
  appAttestBaseSubmissionSchema.extend({
    mode: z.literal("assertion"),
    keyId: appAttestKeyIdSchema,
    assertionObject: standardBase64Schema.max(24_000),
  }),
  appAttestBaseSubmissionSchema.extend({
    mode: z.literal("unsupported"),
  }),
]);

export const iosIntegrityAssessmentResponseSchema = z.object({
  assessment: z.object({
    id: z.string().uuid(),
    signal: z.enum(["low_risk", "elevated_risk", "invalid_binding"]),
    evaluatedAt: z.string().datetime(),
  }),
});

export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string(),
  requestId: z.string().optional(),
  errors: z.record(z.string(), z.array(z.string())).optional(),
});

export type User = z.infer<typeof userSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type Pair = z.infer<typeof pairSchema>;
export type ConsentCapability = z.infer<typeof consentCapabilitySchema>;
export type ConsentResponse = z.infer<typeof consentResponseSchema>;
export type CareRequest = z.infer<typeof careRequestSchema>;
export type CareRequestKind = z.infer<typeof careRequestKindSchema>;
export type CareRequestStatus = z.infer<typeof careRequestStatusSchema>;
export type PrivacyState = z.infer<typeof privacyStateSchema>;
export type AndroidIntegrityAction = z.infer<
  typeof androidIntegrityActionSchema
>;
export type IosIntegrityAction = z.infer<typeof iosIntegrityActionSchema>;
export type AppAttestMode = z.infer<typeof appAttestModeSchema>;
export type RealtimeEventEnvelope = z.infer<typeof realtimeEventEnvelopeSchema>;
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

export const consentCapabilities: readonly ConsentCapability[] =
  consentCapabilitySchema.options;

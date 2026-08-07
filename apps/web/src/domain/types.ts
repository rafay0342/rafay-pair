import type {
  AuthResponse,
  CareRequest as ContractCareRequest,
  CareRequestKind,
  CareRequestStatus,
  ConsentCapability as ContractConsentCapability,
  ConsentResponse,
  Pair as ContractPair,
  PrivacyState as ContractPrivacyState,
  ProblemDetails,
  RealtimeEventEnvelope,
  User as ContractUser,
} from "@rafay-pair/api-contracts";

export type CapabilityState =
  "full" | "limited" | "experimental" | "unsupported";
export type User = ContractUser;
export type AuthResult = AuthResponse;
export type Pair = ContractPair;
export type PairMember = Pair["members"][number];
export type ConsentCapability = ContractConsentCapability;
export type ConsentSet = ConsentResponse;
export type ConsentGrant = ConsentSet["grants"][number];
export type CareKind = CareRequestKind;
export type CareStatus = CareRequestStatus;
export type CareResponse = "accepted" | "declined";
export type CareRequest = ContractCareRequest;
export interface CareRequestList {
  readonly items: readonly CareRequest[];
  readonly nextCursor?: string | undefined;
}
export interface RealtimeTicket {
  readonly ticket: string;
  readonly expiresAt: string;
  readonly webSocketUrl: string;
}
export type RealtimeEnvelope = RealtimeEventEnvelope;
export type PrivacyState = ContractPrivacyState;

export type RealtimeStatus =
  "idle" | "connecting" | "connected" | "recovering" | "offline";

export type ApiProblem = Partial<ProblemDetails>;

export interface OfflineCareDraft {
  readonly clientRequestId: string;
  readonly ownerUserId: string;
  readonly pairId: string;
  readonly kind: Exclude<CareKind, "help" | "call_me">;
  readonly createdAt: string;
}

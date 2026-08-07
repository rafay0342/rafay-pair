import type { CareRequest } from "@rafay-pair/api-contracts";

export interface CareRequestRow {
  id: string;
  client_request_id: string;
  pair_id: string;
  sender_user_id: string;
  recipient_user_id: string;
  kind: CareRequest["kind"];
  message: string | null;
  status: CareRequest["status"];
  created_at: Date;
  responded_at: Date | null;
}

export function serializeCareRequest(row: CareRequestRow): CareRequest {
  return {
    id: row.id,
    clientRequestId: row.client_request_id,
    pairId: row.pair_id,
    senderUserId: row.sender_user_id,
    recipientUserId: row.recipient_user_id,
    kind: row.kind,
    ...(row.message ? { message: row.message } : {}),
    status: row.status,
    createdAt: row.created_at.toISOString(),
    ...(row.responded_at
      ? { respondedAt: row.responded_at.toISOString() }
      : {}),
  };
}

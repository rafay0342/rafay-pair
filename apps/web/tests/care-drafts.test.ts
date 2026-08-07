import { beforeEach, describe, expect, it } from "vitest";

import {
  clearOfflineCareDrafts,
  deleteOfflineCareDraft,
  listOfflineCareDrafts,
  type OfflineCareDraftScope,
  purgeOfflineCareDraftsForOtherUsers,
  saveOfflineCareDraft,
} from "../src/storage/careDrafts";

const firstScope: OfflineCareDraftScope = {
  ownerUserId: "5ca2e98f-56ed-45d7-b90a-e1abf62f01ee",
  pairId: "cba1ca47-fdcb-4ae4-907d-80c2d74fd507",
};
const secondUserScope: OfflineCareDraftScope = {
  ownerUserId: "47fc05cb-50f8-4487-bf9f-6b19cc5c8e1e",
  pairId: "4e251514-b6e6-4649-b90c-a90199225d3a",
};
const secondPairScope: OfflineCareDraftScope = {
  ownerUserId: firstScope.ownerUserId,
  pairId: "f46f16a4-a229-44ea-9410-68966146f776",
};

async function readRawDraft(clientRequestId: string): Promise<unknown> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("rafay-pair-device-drafts", 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction("non-sensitive-care-drafts", "readonly")
        .objectStore("non-sensitive-care-drafts")
        .get(clientRequestId);
      request.onsuccess = () => resolve(request.result as unknown);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

async function readRawKey(scope: OfflineCareDraftScope): Promise<unknown> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("rafay-pair-device-drafts", 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction("care-draft-keys", "readonly")
        .objectStore("care-draft-keys")
        .get(`${scope.ownerUserId}:${scope.pairId}`);
      request.onsuccess = () => resolve(request.result as unknown);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

describe("account-scoped encrypted offline care drafts", () => {
  beforeEach(async () => {
    await clearOfflineCareDrafts();
  });

  it("encrypts the kind and binds the record to its user and active pair", async () => {
    const draft = await saveOfflineCareDraft(firstScope, "check_in");
    const raw = (await readRawDraft(draft.clientRequestId)) as Record<
      string,
      unknown
    >;
    const rawKey = (await readRawKey(firstScope)) as { key?: unknown };
    expect(rawKey.key).toBeDefined();
    expect(raw.kind).toBeUndefined();
    expect(Object.prototype.toString.call(raw.ciphertext)).toBe(
      "[object ArrayBuffer]",
    );
    expect(ArrayBuffer.isView(raw.initializationVector)).toBe(true);
    expect(raw.ownerUserId).toBe(firstScope.ownerUserId);
    expect(raw.pairId).toBe(firstScope.pairId);
    const stored = await listOfflineCareDrafts(firstScope);

    expect(stored).toEqual([draft]);
    expect(stored[0]).toMatchObject(firstScope);
  });

  it("refuses urgent kinds that should never wait offline", async () => {
    await expect(saveOfflineCareDraft(firstScope, "help")).rejects.toThrow(
      /must be sent online/u,
    );
    await expect(saveOfflineCareDraft(firstScope, "call_me")).rejects.toThrow(
      /must be sent online/u,
    );
    await expect(listOfflineCareDrafts(firstScope)).resolves.toEqual([]);
  });

  it("isolates records by both account and pair", async () => {
    const first = await saveOfflineCareDraft(firstScope, "encouragement");
    const otherUser = await saveOfflineCareDraft(
      secondUserScope,
      "breathe_together",
    );
    const otherPair = await saveOfflineCareDraft(
      secondPairScope,
      "move_together",
    );

    await expect(listOfflineCareDrafts(firstScope)).resolves.toEqual([first]);
    await expect(listOfflineCareDrafts(secondUserScope)).resolves.toEqual([
      otherUser,
    ]);
    await expect(listOfflineCareDrafts(secondPairScope)).resolves.toEqual([
      otherPair,
    ]);
  });

  it("will not delete another account's record by id", async () => {
    const draft = await saveOfflineCareDraft(firstScope, "encouragement");
    await deleteOfflineCareDraft(secondUserScope, draft.clientRequestId);
    await expect(listOfflineCareDrafts(firstScope)).resolves.toEqual([draft]);

    await deleteOfflineCareDraft(firstScope, draft.clientRequestId);
    await expect(listOfflineCareDrafts(firstScope)).resolves.toEqual([]);
  });

  it("purges abandoned records when the authenticated account changes", async () => {
    const retained = await saveOfflineCareDraft(firstScope, "check_in");
    await saveOfflineCareDraft(secondUserScope, "encouragement");

    await purgeOfflineCareDraftsForOtherUsers(firstScope.ownerUserId);

    await expect(listOfflineCareDrafts(firstScope)).resolves.toEqual([
      retained,
    ]);
    await expect(listOfflineCareDrafts(secondUserScope)).resolves.toEqual([]);
  });
});

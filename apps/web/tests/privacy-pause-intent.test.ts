import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearPrivacyPauseIntent,
  type PrivacyPauseScope,
  PrivacyPauseStorageError,
  readPrivacyPauseIntent,
  subscribePrivacyPauseIntentChanges,
  writePrivacyPauseIntent,
} from "../src/storage/privacyPauseIntent";

const DATABASE_NAME = "rafay-pair-privacy-boundary";
const INTENT_STORE_NAME = "encrypted-pause-intents";
const KEY_STORE_NAME = "non-exportable-pause-keys";
const LEGACY_STORAGE_PREFIX = "rafay-pair:privacy-pause:v1:";

const firstScope: PrivacyPauseScope = {
  userId: "5ca2e98f-56ed-45d7-b90a-e1abf62f01ee",
  pairId: "cba1ca47-fdcb-4ae4-907d-80c2d74fd507",
};
const secondScope: PrivacyPauseScope = {
  userId: "47fc05cb-50f8-4487-bf9f-6b19cc5c8e1e",
  pairId: firstScope.pairId,
};

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function allRecords(storeName: string): Promise<unknown[]> {
  const database = await openDatabase();
  try {
    return await requestResult(
      database
        .transaction(storeName, "readonly")
        .objectStore(storeName)
        .getAll(),
    );
  } finally {
    database.close();
  }
}

async function corruptOnlyEncryptedIntent(): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(INTENT_STORE_NAME, "readwrite");
    const store = transaction.objectStore(INTENT_STORE_NAME);
    const records = await requestResult<unknown[]>(store.getAll());
    const record = records[0] as {
      ciphertext: ArrayBuffer;
      initializationVector: Uint8Array;
      scopeKey: string;
      version: number;
    };
    const ciphertext = record.ciphertext.slice(0);
    const bytes = new Uint8Array(ciphertext);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    await requestResult(store.put({ ...record, ciphertext }));
  } finally {
    database.close();
  }
}

describe("durable privacy pause intent", () => {
  beforeEach(async () => {
    localStorage.clear();
    await clearPrivacyPauseIntent(firstScope);
    await clearPrivacyPauseIntent(secondScope);
  });

  it("survives reload-equivalent reads and records server confirmation", async () => {
    await writePrivacyPauseIntent(firstScope, false);
    await expect(readPrivacyPauseIntent(firstScope)).resolves.toMatchObject({
      desiredState: "paused",
      serverConfirmed: false,
    });

    await writePrivacyPauseIntent(firstScope, true);
    await expect(readPrivacyPauseIntent(firstScope)).resolves.toMatchObject({
      serverConfirmed: true,
    });
  });

  it("encrypts the complete record under a non-exportable scope-bound key", async () => {
    const intent = await writePrivacyPauseIntent(firstScope, false);
    const [encryptedRecords, keyRecords] = await Promise.all([
      allRecords(INTENT_STORE_NAME),
      allRecords(KEY_STORE_NAME),
    ]);

    expect(encryptedRecords).toHaveLength(1);
    expect(keyRecords).toHaveLength(1);
    const serializedEnvelope = JSON.stringify(encryptedRecords[0]);
    expect(serializedEnvelope).not.toContain(firstScope.userId);
    expect(serializedEnvelope).not.toContain(firstScope.pairId);
    expect(serializedEnvelope).not.toContain(intent.updatedAt);
    expect(serializedEnvelope).not.toContain("paused");
    expect(encryptedRecords[0]).not.toHaveProperty("userId");
    expect(encryptedRecords[0]).not.toHaveProperty("pairId");
    expect(encryptedRecords[0]).not.toHaveProperty("serverConfirmed");

    const storedKey = (keyRecords[0] as { key: CryptoKey }).key;
    expect(storedKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", storedKey)).rejects.toThrow(
      /extractable|export/iu,
    );
  });

  it("does not expose one account's pause to another account", async () => {
    await writePrivacyPauseIntent(firstScope, false);
    await expect(readPrivacyPauseIntent(secondScope)).resolves.toBeUndefined();
    await expect(readPrivacyPauseIntent(firstScope)).resolves.toBeDefined();
  });

  it("fails closed once when legacy plaintext state is purged", async () => {
    const legacyKey = `${LEGACY_STORAGE_PREFIX}${firstScope.userId}:${firstScope.pairId}`;
    localStorage.setItem(
      legacyKey,
      JSON.stringify({
        userId: firstScope.userId,
        pairId: firstScope.pairId,
        desiredState: "paused",
      }),
    );

    await expect(readPrivacyPauseIntent(firstScope)).rejects.toBeInstanceOf(
      PrivacyPauseStorageError,
    );
    expect(localStorage).toHaveLength(0);
    await expect(readPrivacyPauseIntent(firstScope)).resolves.toBeUndefined();
  });

  it("quarantines ciphertext that fails authenticated decryption", async () => {
    await writePrivacyPauseIntent(firstScope, true);
    await corruptOnlyEncryptedIntent();

    await expect(readPrivacyPauseIntent(firstScope)).rejects.toBeInstanceOf(
      PrivacyPauseStorageError,
    );
    await expect(readPrivacyPauseIntent(firstScope)).resolves.toBeUndefined();
  });

  it("notifies same-document listeners without a sensitive payload", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribePrivacyPauseIntentChanges(listener);
    try {
      await writePrivacyPauseIntent(firstScope, false);
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0]).toEqual([]);

      await clearPrivacyPauseIntent(firstScope);
      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener.mock.calls[1]).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("never writes privacy identifiers or state into LocalStorage", async () => {
    await writePrivacyPauseIntent(firstScope, false);
    await readPrivacyPauseIntent(firstScope);
    await clearPrivacyPauseIntent(firstScope);
    expect(localStorage).toHaveLength(0);
  });
});

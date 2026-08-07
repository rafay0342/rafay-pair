import type { CareKind, OfflineCareDraft } from "../domain/types";

const DATABASE_NAME = "rafay-pair-device-drafts";
const DATABASE_VERSION = 2;
const DRAFT_STORE_NAME = "non-sensitive-care-drafts";
const KEY_STORE_NAME = "care-draft-keys";
const OWNER_PAIR_INDEX = "owner-pair";
const RECORD_VERSION = 2;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface OfflineCareDraftScope {
  readonly ownerUserId: string;
  readonly pairId: string;
}

interface StoredEncryptedCareDraft {
  readonly version: typeof RECORD_VERSION;
  readonly clientRequestId: string;
  readonly ownerUserId: string;
  readonly pairId: string;
  readonly createdAt: string;
  readonly initializationVector: Uint8Array<ArrayBuffer>;
  readonly ciphertext: ArrayBuffer;
}

interface StoredDraftKey {
  readonly scopeKey: string;
  readonly ownerUserId: string;
  readonly pairId: string;
  readonly createdAt: string;
  readonly key: CryptoKey;
}

interface EncryptedDraftPayload {
  readonly kind: OfflineCareDraft["kind"];
}

function isSafeOfflineKind(value: unknown): value is OfflineCareDraft["kind"] {
  return (
    value === "check_in" ||
    value === "encouragement" ||
    value === "breathe_together" ||
    value === "move_together"
  );
}

function assertScope(scope: OfflineCareDraftScope): void {
  if (
    !UUID_PATTERN.test(scope.ownerUserId) ||
    !UUID_PATTERN.test(scope.pairId)
  ) {
    throw new Error("Offline draft storage requires a valid user and pair.");
  }
}

function scopeKey(scope: OfflineCareDraftScope): string {
  assertScope(scope);
  return `${scope.ownerUserId}:${scope.pairId}`;
}

function createStores(database: IDBDatabase): void {
  const drafts = database.createObjectStore(DRAFT_STORE_NAME, {
    keyPath: "clientRequestId",
  });
  drafts.createIndex(OWNER_PAIR_INDEX, ["ownerUserId", "pairId"], {
    unique: false,
  });
  database.createObjectStore(KEY_STORE_NAME, { keyPath: "scopeKey" });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = (event) => {
      const database = request.result;
      const oldVersion = event.oldVersion;

      // Version 1 records had no authenticated owner or pair binding. They
      // cannot be attributed safely, so the only safe migration is deletion.
      if (oldVersion < 2) {
        if (database.objectStoreNames.contains(DRAFT_STORE_NAME)) {
          database.deleteObjectStore(DRAFT_STORE_NAME);
        }
        if (database.objectStoreNames.contains(KEY_STORE_NAME)) {
          database.deleteObjectStore(KEY_STORE_NAME);
        }
        createStores(database);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ?? new Error("Could not open offline draft storage."),
      );
    request.onblocked = () =>
      reject(new Error("Offline draft storage upgrade is blocked."));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Offline draft operation failed."));
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error ?? new Error("Offline draft transaction failed."),
      );
    transaction.onabort = () =>
      reject(
        transaction.error ?? new Error("Offline draft transaction aborted."),
      );
  });
}

async function readDraftRecords(
  scope: OfflineCareDraftScope,
): Promise<readonly unknown[]> {
  assertScope(scope);
  const database = await openDatabase();
  try {
    const transaction = database.transaction(DRAFT_STORE_NAME, "readonly");
    const completion = transactionCompletion(transaction);
    const request = transaction
      .objectStore(DRAFT_STORE_NAME)
      .index(OWNER_PAIR_INDEX)
      .getAll(IDBKeyRange.only([scope.ownerUserId, scope.pairId]));
    const values = await requestResult<unknown[]>(request);
    await completion;
    return values;
  } finally {
    database.close();
  }
}

async function readStoredKey(
  scope: OfflineCareDraftScope,
): Promise<StoredDraftKey | undefined> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(KEY_STORE_NAME, "readonly");
    const completion = transactionCompletion(transaction);
    const value = await requestResult<unknown>(
      transaction.objectStore(KEY_STORE_NAME).get(scopeKey(scope)),
    );
    await completion;
    if (!value || typeof value !== "object") return undefined;
    const candidate = value as Partial<StoredDraftKey>;
    if (
      candidate.scopeKey !== scopeKey(scope) ||
      candidate.ownerUserId !== scope.ownerUserId ||
      candidate.pairId !== scope.pairId ||
      typeof candidate.createdAt !== "string" ||
      !candidate.key
    ) {
      return undefined;
    }
    return {
      scopeKey: candidate.scopeKey,
      ownerUserId: candidate.ownerUserId,
      pairId: candidate.pairId,
      createdAt: candidate.createdAt,
      key: candidate.key,
    };
  } finally {
    database.close();
  }
}

async function addStoredKey(record: StoredDraftKey): Promise<boolean> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(KEY_STORE_NAME, "readwrite");
    const completion = transactionCompletion(transaction);
    try {
      await requestResult(transaction.objectStore(KEY_STORE_NAME).add(record));
      await completion;
      return true;
    } catch (error) {
      // A second tab may have created the same scope key first. Its committed
      // key is authoritative; no encrypted record was written with this key.
      if (error instanceof DOMException && error.name === "ConstraintError") {
        await completion.catch(() => undefined);
        return false;
      }
      throw error;
    }
  } finally {
    database.close();
  }
}

async function getOrCreateScopeKey(
  scope: OfflineCareDraftScope,
): Promise<CryptoKey> {
  const existing = await readStoredKey(scope);
  if (existing) return existing.key;

  const generated = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const record: StoredDraftKey = {
    scopeKey: scopeKey(scope),
    ownerUserId: scope.ownerUserId,
    pairId: scope.pairId,
    createdAt: new Date().toISOString(),
    key: generated,
  };
  if (await addStoredKey(record)) return generated;

  const raced = await readStoredKey(scope);
  if (!raced) throw new Error("Offline draft encryption key was unavailable.");
  return raced.key;
}

function additionalData(
  record: Pick<
    StoredEncryptedCareDraft,
    "clientRequestId" | "ownerUserId" | "pairId" | "createdAt"
  >,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    [
      RECORD_VERSION,
      record.clientRequestId,
      record.ownerUserId,
      record.pairId,
      record.createdAt,
    ].join("\u001f"),
  );
}

function isStoredEncryptedDraft(
  value: unknown,
  scope: OfflineCareDraftScope,
): value is StoredEncryptedCareDraft {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredEncryptedCareDraft>;
  return (
    candidate.version === RECORD_VERSION &&
    typeof candidate.clientRequestId === "string" &&
    UUID_PATTERN.test(candidate.clientRequestId) &&
    candidate.ownerUserId === scope.ownerUserId &&
    candidate.pairId === scope.pairId &&
    typeof candidate.createdAt === "string" &&
    ArrayBuffer.isView(candidate.initializationVector) &&
    candidate.initializationVector.BYTES_PER_ELEMENT === 1 &&
    candidate.initializationVector.byteLength === 12 &&
    Object.prototype.toString.call(candidate.ciphertext) ===
      "[object ArrayBuffer]"
  );
}

async function decryptDraft(
  record: StoredEncryptedCareDraft,
  key: CryptoKey,
): Promise<OfflineCareDraft> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: record.initializationVector,
      additionalData: additionalData(record),
    },
    key,
    record.ciphertext,
  );
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Offline draft payload was invalid.");
  }
  const payload = parsed as Partial<EncryptedDraftPayload>;
  if (!isSafeOfflineKind(payload.kind)) {
    throw new Error("Offline draft kind was invalid.");
  }
  return {
    clientRequestId: record.clientRequestId,
    ownerUserId: record.ownerUserId,
    pairId: record.pairId,
    kind: payload.kind,
    createdAt: record.createdAt,
  };
}

async function putDraftRecord(record: StoredEncryptedCareDraft): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(DRAFT_STORE_NAME, "readwrite");
    const completion = transactionCompletion(transaction);
    await requestResult(transaction.objectStore(DRAFT_STORE_NAME).put(record));
    await completion;
  } finally {
    database.close();
  }
}

async function deleteDraftRecords(
  clientRequestIds: readonly string[],
): Promise<void> {
  if (clientRequestIds.length === 0) return;
  const database = await openDatabase();
  try {
    const transaction = database.transaction(DRAFT_STORE_NAME, "readwrite");
    const completion = transactionCompletion(transaction);
    const store = transaction.objectStore(DRAFT_STORE_NAME);
    for (const clientRequestId of clientRequestIds) {
      store.delete(clientRequestId);
    }
    await completion;
  } finally {
    database.close();
  }
}

export async function saveOfflineCareDraft(
  scope: OfflineCareDraftScope,
  kind: CareKind,
): Promise<OfflineCareDraft> {
  assertScope(scope);
  if (!isSafeOfflineKind(kind)) {
    throw new Error(
      "This care request must be sent online and cannot be stored on the device.",
    );
  }

  const draft: OfflineCareDraft = {
    clientRequestId: crypto.randomUUID(),
    ownerUserId: scope.ownerUserId,
    pairId: scope.pairId,
    kind,
    createdAt: new Date().toISOString(),
  };
  const key = await getOrCreateScopeKey(scope);
  const initializationVector = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: initializationVector,
      additionalData: additionalData(draft),
    },
    key,
    new TextEncoder().encode(JSON.stringify({ kind })),
  );
  await putDraftRecord({
    version: RECORD_VERSION,
    clientRequestId: draft.clientRequestId,
    ownerUserId: draft.ownerUserId,
    pairId: draft.pairId,
    createdAt: draft.createdAt,
    initializationVector,
    ciphertext,
  });
  return draft;
}

export async function listOfflineCareDrafts(
  scope: OfflineCareDraftScope,
): Promise<readonly OfflineCareDraft[]> {
  const values = await readDraftRecords(scope);
  if (values.length === 0) return [];
  const storedKey = await readStoredKey(scope);
  if (!storedKey) {
    await deleteDraftRecords(
      values.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const id = (value as { clientRequestId?: unknown }).clientRequestId;
        return typeof id === "string" ? [id] : [];
      }),
    );
    return [];
  }

  const drafts: OfflineCareDraft[] = [];
  const invalidIds: string[] = [];
  for (const value of values) {
    if (!isStoredEncryptedDraft(value, scope)) {
      if (value && typeof value === "object") {
        const id = (value as { clientRequestId?: unknown }).clientRequestId;
        if (typeof id === "string") invalidIds.push(id);
      }
      continue;
    }
    try {
      drafts.push(await decryptDraft(value, storedKey.key));
    } catch {
      invalidIds.push(value.clientRequestId);
    }
  }
  await deleteDraftRecords(invalidIds);
  return drafts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function deleteOfflineCareDraft(
  scope: OfflineCareDraftScope,
  clientRequestId: string,
): Promise<void> {
  assertScope(scope);
  const database = await openDatabase();
  try {
    const transaction = database.transaction(DRAFT_STORE_NAME, "readwrite");
    const completion = transactionCompletion(transaction);
    const store = transaction.objectStore(DRAFT_STORE_NAME);
    const value = await requestResult<unknown>(store.get(clientRequestId));
    if (isStoredEncryptedDraft(value, scope)) store.delete(clientRequestId);
    await completion;
  } finally {
    database.close();
  }
}

export async function clearOfflineCareDrafts(
  scope?: OfflineCareDraftScope,
): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(
      [DRAFT_STORE_NAME, KEY_STORE_NAME],
      "readwrite",
    );
    const completion = transactionCompletion(transaction);
    const drafts = transaction.objectStore(DRAFT_STORE_NAME);
    const keys = transaction.objectStore(KEY_STORE_NAME);
    if (!scope) {
      drafts.clear();
      keys.clear();
    } else {
      assertScope(scope);
      const ids = await requestResult<IDBValidKey[]>(
        drafts
          .index(OWNER_PAIR_INDEX)
          .getAllKeys(IDBKeyRange.only([scope.ownerUserId, scope.pairId])),
      );
      for (const id of ids) drafts.delete(id);
      keys.delete(scopeKey(scope));
    }
    await completion;
  } finally {
    database.close();
  }
}

export async function purgeOfflineCareDraftsForOtherUsers(
  ownerUserId: string,
): Promise<void> {
  if (!UUID_PATTERN.test(ownerUserId)) {
    await clearOfflineCareDrafts();
    return;
  }
  const database = await openDatabase();
  try {
    const transaction = database.transaction(
      [DRAFT_STORE_NAME, KEY_STORE_NAME],
      "readwrite",
    );
    const completion = transactionCompletion(transaction);
    const drafts = transaction.objectStore(DRAFT_STORE_NAME);
    const keys = transaction.objectStore(KEY_STORE_NAME);
    const [draftRecords, keyRecords] = await Promise.all([
      requestResult<unknown[]>(drafts.getAll()),
      requestResult<unknown[]>(keys.getAll()),
    ]);
    for (const value of draftRecords) {
      if (!value || typeof value !== "object") continue;
      const candidate = value as {
        clientRequestId?: unknown;
        ownerUserId?: unknown;
      };
      if (
        candidate.ownerUserId !== ownerUserId &&
        typeof candidate.clientRequestId === "string"
      ) {
        drafts.delete(candidate.clientRequestId);
      }
    }
    for (const value of keyRecords) {
      if (!value || typeof value !== "object") continue;
      const candidate = value as {
        scopeKey?: unknown;
        ownerUserId?: unknown;
      };
      if (
        candidate.ownerUserId !== ownerUserId &&
        typeof candidate.scopeKey === "string"
      ) {
        keys.delete(candidate.scopeKey);
      }
    }
    await completion;
  } finally {
    database.close();
  }
}

export function canQueueCareKind(
  kind: CareKind,
): kind is OfflineCareDraft["kind"] {
  return isSafeOfflineKind(kind);
}

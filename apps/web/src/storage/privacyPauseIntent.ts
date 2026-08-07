const DATABASE_NAME = "rafay-pair-privacy-boundary";
const DATABASE_VERSION = 1;
const INTENT_STORE_NAME = "encrypted-pause-intents";
const KEY_STORE_NAME = "non-exportable-pause-keys";
const LEGACY_STORAGE_PREFIX = "rafay-pair:privacy-pause:v1:";
const CHANGE_CHANNEL_NAME = "rafay-pair:privacy-boundary:changed";
const CHANGE_MESSAGE = "privacy-boundary-changed";
const RECORD_VERSION = 2;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface PrivacyPauseScope {
  readonly userId: string;
  readonly pairId: string;
}

export interface PrivacyPauseIntent {
  readonly version: typeof RECORD_VERSION;
  readonly userId: string;
  readonly pairId: string;
  readonly desiredState: "paused";
  readonly serverConfirmed: boolean;
  readonly updatedAt: string;
}

interface StoredEncryptedPrivacyPauseIntent {
  readonly version: typeof RECORD_VERSION;
  readonly scopeKey: string;
  readonly initializationVector: Uint8Array<ArrayBuffer>;
  readonly ciphertext: ArrayBuffer;
}

interface StoredPrivacyPauseKey {
  readonly scopeKey: string;
  readonly key: CryptoKey;
}

type PrivacyPauseIntentChangeListener = () => void;

interface PrivacyPauseMutationOptions {
  readonly notifySameDocument?: boolean;
}

const changeListeners = new Set<PrivacyPauseIntentChangeListener>();
const scopeMutationCompletions = new Map<string, Promise<void>>();
let changeChannel: BroadcastChannel | undefined;

export class PrivacyPauseStorageError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PrivacyPauseStorageError";
  }
}

function asStorageError(message: string, cause: unknown): Error {
  if (cause instanceof PrivacyPauseStorageError) return cause;
  return new PrivacyPauseStorageError(message, { cause });
}

function assertScope(scope: PrivacyPauseScope): void {
  if (!UUID_PATTERN.test(scope.userId) || !UUID_PATTERN.test(scope.pairId)) {
    throw new PrivacyPauseStorageError(
      "Privacy pause storage requires a valid user and pair.",
    );
  }
}

async function privacyScopeKey(scope: PrivacyPauseScope): Promise<string> {
  assertScope(scope);
  const encodedScope = new TextEncoder().encode(
    `rafay-pair:privacy-pause:scope:v2\u001f${scope.userId}\u001f${scope.pairId}`,
  );
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encodedScope),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function createStores(database: IDBDatabase): void {
  database.createObjectStore(INTENT_STORE_NAME, { keyPath: "scopeKey" });
  database.createObjectStore(KEY_STORE_NAME, { keyPath: "scopeKey" });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    } catch (error) {
      reject(asStorageError("Could not open privacy pause storage.", error));
      return;
    }

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(INTENT_STORE_NAME)) {
        createStores(database);
      }
    };
    request.onsuccess = () => {
      if (blocked) {
        request.result.close();
        return;
      }
      resolve(request.result);
    };
    request.onerror = () =>
      reject(
        asStorageError("Could not open privacy pause storage.", request.error),
      );
    request.onblocked = () => {
      blocked = true;
      reject(
        new PrivacyPauseStorageError(
          "Privacy pause storage upgrade is blocked.",
        ),
      );
    };
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        asStorageError(
          "Privacy pause storage operation failed.",
          request.error,
        ),
      );
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        asStorageError(
          "Privacy pause storage transaction failed.",
          transaction.error,
        ),
      );
    transaction.onabort = () =>
      reject(
        asStorageError(
          "Privacy pause storage transaction aborted.",
          transaction.error,
        ),
      );
  });
}

async function purgeLegacyLocalStorageRecords(): Promise<void> {
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(LEGACY_STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
    if (keys.length > 0) {
      throw new PrivacyPauseStorageError(
        "Legacy privacy pause state was removed; privacy remains blocked until it is verified again.",
      );
    }
  } catch (error) {
    throw asStorageError(
      "Legacy privacy pause storage could not be verified.",
      error,
    );
  }
}

function getChangeChannel(): BroadcastChannel | undefined {
  if (changeChannel) return changeChannel;
  if (typeof BroadcastChannel !== "function") return undefined;
  try {
    const channel = new BroadcastChannel(CHANGE_CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data !== CHANGE_MESSAGE) return;
      notifySameDocumentListeners();
    };
    changeChannel = channel;
    return channel;
  } catch {
    // BroadcastChannel is a synchronization optimization. Visibility and
    // server refreshes preserve the fail-closed boundary when unavailable.
    return undefined;
  }
}

function notifySameDocumentListeners(): void {
  for (const listener of changeListeners) {
    try {
      listener();
    } catch {
      // A subscriber cannot invalidate an already-committed privacy record or
      // prevent another mounted provider from closing its sharing boundary.
    }
  }
}

function notifyPrivacyPauseIntentChanged(
  options: PrivacyPauseMutationOptions,
): void {
  if (options.notifySameDocument !== false) {
    notifySameDocumentListeners();
  }
  try {
    getChangeChannel()?.postMessage(CHANGE_MESSAGE);
  } catch {
    changeChannel?.close();
    changeChannel = undefined;
  }
}

export function subscribePrivacyPauseIntentChanges(
  listener: PrivacyPauseIntentChangeListener,
): () => void {
  changeListeners.add(listener);
  getChangeChannel();
  return () => {
    changeListeners.delete(listener);
    if (changeListeners.size === 0 && changeChannel) {
      changeChannel.close();
      changeChannel = undefined;
    }
  };
}

function additionalData(scopeKey: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `rafay-pair:privacy-pause:aes-gcm:v${RECORD_VERSION}\u001f${scopeKey}`,
  );
}

async function runScopeMutation<T>(
  scopeKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = scopeMutationCompletions.get(scopeKey);
  const result = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(operation);
  const completion = result.then(
    () => undefined,
    () => undefined,
  );
  scopeMutationCompletions.set(scopeKey, completion);
  try {
    return await result;
  } finally {
    if (scopeMutationCompletions.get(scopeKey) === completion) {
      scopeMutationCompletions.delete(scopeKey);
    }
  }
}

function isStoredEncryptedIntent(
  value: unknown,
  expectedScopeKey: string,
): value is StoredEncryptedPrivacyPauseIntent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredEncryptedPrivacyPauseIntent>;
  return (
    candidate.version === RECORD_VERSION &&
    candidate.scopeKey === expectedScopeKey &&
    ArrayBuffer.isView(candidate.initializationVector) &&
    candidate.initializationVector.BYTES_PER_ELEMENT === 1 &&
    candidate.initializationVector.byteLength === 12 &&
    Object.prototype.toString.call(candidate.ciphertext) ===
      "[object ArrayBuffer]"
  );
}

function isUsableStoredKey(
  value: unknown,
  expectedScopeKey: string,
): value is StoredPrivacyPauseKey {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredPrivacyPauseKey>;
  const key = candidate.key;
  return (
    candidate.scopeKey === expectedScopeKey &&
    Boolean(key) &&
    key?.type === "secret" &&
    !key.extractable &&
    key.algorithm.name === "AES-GCM" &&
    key.usages.includes("encrypt") &&
    key.usages.includes("decrypt")
  );
}

function isIntent(
  value: unknown,
  scope: PrivacyPauseScope,
): value is PrivacyPauseIntent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PrivacyPauseIntent>;
  if (
    candidate.version !== RECORD_VERSION ||
    candidate.userId !== scope.userId ||
    candidate.pairId !== scope.pairId ||
    candidate.desiredState !== "paused" ||
    typeof candidate.serverConfirmed !== "boolean" ||
    typeof candidate.updatedAt !== "string"
  ) {
    return false;
  }
  const parsedTimestamp = new Date(candidate.updatedAt);
  return (
    !Number.isNaN(parsedTimestamp.valueOf()) &&
    parsedTimestamp.toISOString() === candidate.updatedAt
  );
}

async function readScopeRecords(scopeKey: string): Promise<{
  readonly encryptedIntent: unknown;
  readonly storedKey: unknown;
}> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(
      [INTENT_STORE_NAME, KEY_STORE_NAME],
      "readonly",
    );
    const completion = transactionCompletion(transaction);
    try {
      const [encryptedIntent, storedKey] = await Promise.all([
        requestResult<unknown>(
          transaction.objectStore(INTENT_STORE_NAME).get(scopeKey),
        ),
        requestResult<unknown>(
          transaction.objectStore(KEY_STORE_NAME).get(scopeKey),
        ),
      ]);
      await completion;
      return { encryptedIntent, storedKey };
    } catch (error) {
      await completion.catch(() => undefined);
      throw error;
    }
  } finally {
    database.close();
  }
}

async function deleteScopeRecords(scopeKey: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(
      [INTENT_STORE_NAME, KEY_STORE_NAME],
      "readwrite",
    );
    const completion = transactionCompletion(transaction);
    transaction.objectStore(INTENT_STORE_NAME).delete(scopeKey);
    transaction.objectStore(KEY_STORE_NAME).delete(scopeKey);
    await completion;
  } finally {
    database.close();
  }
}

async function readStoredKey(scopeKey: string): Promise<CryptoKey | undefined> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(KEY_STORE_NAME, "readonly");
    const completion = transactionCompletion(transaction);
    let value: unknown;
    try {
      value = await requestResult<unknown>(
        transaction.objectStore(KEY_STORE_NAME).get(scopeKey),
      );
      await completion;
    } catch (error) {
      await completion.catch(() => undefined);
      throw error;
    }
    if (value === undefined) return undefined;
    if (!isUsableStoredKey(value, scopeKey)) {
      throw new PrivacyPauseStorageError(
        "Privacy pause encryption key was invalid.",
      );
    }
    return value.key;
  } finally {
    database.close();
  }
}

async function addStoredKey(
  scopeKey: string,
  key: CryptoKey,
): Promise<boolean> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(KEY_STORE_NAME, "readwrite");
    const completion = transactionCompletion(transaction);
    try {
      await requestResult(
        transaction.objectStore(KEY_STORE_NAME).add({ scopeKey, key }),
      );
      await completion;
      return true;
    } catch (error) {
      await completion.catch(() => undefined);
      if (
        error &&
        typeof error === "object" &&
        "name" in error &&
        error.name === "ConstraintError"
      ) {
        return false;
      }
      throw error;
    }
  } finally {
    database.close();
  }
}

async function getOrCreateScopeKey(scopeKey: string): Promise<CryptoKey> {
  const existing = await readStoredKey(scopeKey);
  if (existing) return existing;

  const generated = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  if (await addStoredKey(scopeKey, generated)) return generated;

  const raced = await readStoredKey(scopeKey);
  if (!raced) {
    throw new PrivacyPauseStorageError(
      "Privacy pause encryption key was unavailable.",
    );
  }
  return raced;
}

async function putEncryptedIntent(
  record: StoredEncryptedPrivacyPauseIntent,
): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(INTENT_STORE_NAME, "readwrite");
    const completion = transactionCompletion(transaction);
    try {
      await requestResult(
        transaction.objectStore(INTENT_STORE_NAME).put(record),
      );
      await completion;
    } catch (error) {
      await completion.catch(() => undefined);
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function readPrivacyPauseIntent(
  scope: PrivacyPauseScope,
): Promise<PrivacyPauseIntent | undefined> {
  await purgeLegacyLocalStorageRecords();
  const scopeKey = await privacyScopeKey(scope);
  await scopeMutationCompletions.get(scopeKey);
  const { encryptedIntent, storedKey } = await readScopeRecords(scopeKey);
  if (encryptedIntent === undefined) return undefined;

  if (
    !isStoredEncryptedIntent(encryptedIntent, scopeKey) ||
    !isUsableStoredKey(storedKey, scopeKey)
  ) {
    await deleteScopeRecords(scopeKey).catch(() => undefined);
    throw new PrivacyPauseStorageError(
      "Privacy pause state was corrupt and has been quarantined.",
    );
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: encryptedIntent.initializationVector,
        additionalData: additionalData(scopeKey),
      },
      storedKey.key,
      encryptedIntent.ciphertext,
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    if (!isIntent(parsed, scope)) {
      throw new PrivacyPauseStorageError(
        "Privacy pause payload did not match its authenticated scope.",
      );
    }
    return parsed;
  } catch (error) {
    await deleteScopeRecords(scopeKey).catch(() => undefined);
    throw asStorageError(
      "Privacy pause state could not be authenticated and has been quarantined.",
      error,
    );
  }
}

export async function writePrivacyPauseIntent(
  scope: PrivacyPauseScope,
  serverConfirmed: boolean,
  options: PrivacyPauseMutationOptions = {},
): Promise<PrivacyPauseIntent> {
  await purgeLegacyLocalStorageRecords();
  const scopeKey = await privacyScopeKey(scope);
  return runScopeMutation(scopeKey, async () => {
    const intent: PrivacyPauseIntent = {
      version: RECORD_VERSION,
      userId: scope.userId,
      pairId: scope.pairId,
      desiredState: "paused",
      serverConfirmed,
      updatedAt: new Date().toISOString(),
    };

    let key: CryptoKey;
    try {
      key = await getOrCreateScopeKey(scopeKey);
    } catch (error) {
      await deleteScopeRecords(scopeKey).catch(() => undefined);
      throw asStorageError(
        "Privacy pause state could not be encrypted.",
        error,
      );
    }
    const initializationVector = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: initializationVector,
        additionalData: additionalData(scopeKey),
      },
      key,
      new TextEncoder().encode(JSON.stringify(intent)),
    );
    await putEncryptedIntent({
      version: RECORD_VERSION,
      scopeKey,
      initializationVector,
      ciphertext,
    });
    notifyPrivacyPauseIntentChanged(options);
    return intent;
  });
}

export async function clearPrivacyPauseIntent(
  scope: PrivacyPauseScope,
  options: PrivacyPauseMutationOptions = {},
): Promise<void> {
  await purgeLegacyLocalStorageRecords();
  const scopeKey = await privacyScopeKey(scope);
  await runScopeMutation(scopeKey, async () => {
    await deleteScopeRecords(scopeKey);
    notifyPrivacyPauseIntentChanged(options);
  });
}

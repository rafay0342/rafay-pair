export type CborValue =
  | null
  | boolean
  | number
  | string
  | Buffer
  | CborValue[]
  | Map<CborMapKey, CborValue>;

export type CborMapKey = number | string | Buffer;

const maximumDepth = 16;
const maximumCollectionItems = 256;
const maximumByteStringLength = 64 * 1_024;
const maximumTextStringLength = 4 * 1_024;

export class CborDecodingError extends Error {
  public constructor() {
    super("Invalid App Attest CBOR object");
    this.name = "CborDecodingError";
  }
}

export function decodeCborExact(input: Buffer): CborValue {
  const decoded = decodeCborFirst(input);
  if (decoded.bytesRead !== input.length) throw new CborDecodingError();
  return decoded.value;
}

export function decodeCborFirst(input: Buffer): {
  value: CborValue;
  bytesRead: number;
} {
  if (input.length === 0 || input.length > maximumByteStringLength) {
    throw new CborDecodingError();
  }
  const decoder = new StrictCborDecoder(input);
  const value = decoder.readValue(0);
  return { value, bytesRead: decoder.offset };
}

export function requireCborMap(value: CborValue): Map<CborMapKey, CborValue> {
  if (!(value instanceof Map)) throw new CborDecodingError();
  return value;
}

export function requireCborArray(value: CborValue): CborValue[] {
  if (!Array.isArray(value)) throw new CborDecodingError();
  return value;
}

export function requireCborBytes(value: CborValue): Buffer {
  if (!Buffer.isBuffer(value)) throw new CborDecodingError();
  return value;
}

export function requireCborText(value: CborValue): string {
  if (typeof value !== "string") throw new CborDecodingError();
  return value;
}

export function requireCborInteger(value: CborValue): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new CborDecodingError();
  }
  return value;
}

export function requireMapValue(
  map: Map<CborMapKey, CborValue>,
  key: CborMapKey,
): CborValue {
  const value = map.get(key);
  if (value === undefined) throw new CborDecodingError();
  return value;
}

export function assertOnlyMapKeys(
  map: Map<CborMapKey, CborValue>,
  allowed: readonly CborMapKey[],
): void {
  const identities = new Set(allowed.map(mapKeyIdentity));
  for (const key of map.keys()) {
    if (!identities.has(mapKeyIdentity(key))) throw new CborDecodingError();
  }
}

class StrictCborDecoder {
  public offset = 0;
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });

  public constructor(private readonly input: Buffer) {}

  public readValue(depth: number): CborValue {
    if (depth > maximumDepth) throw new CborDecodingError();
    const initial = this.readByte();
    const major = initial >> 5;
    const additional = initial & 0x1f;
    switch (major) {
      case 0:
        return this.readUnsigned(additional);
      case 1:
        return -1 - this.readUnsigned(additional);
      case 2:
        return this.readBytes(additional, maximumByteStringLength);
      case 3: {
        const bytes = this.readBytes(additional, maximumTextStringLength);
        try {
          return this.utf8.decode(bytes);
        } catch {
          throw new CborDecodingError();
        }
      }
      case 4:
        return this.readArray(additional, depth);
      case 5:
        return this.readMap(additional, depth);
      case 7:
        if (additional === 20) return false;
        if (additional === 21) return true;
        if (additional === 22) return null;
        throw new CborDecodingError();
      default:
        throw new CborDecodingError();
    }
  }

  private readArray(additional: number, depth: number): CborValue[] {
    const length = this.readLength(additional, maximumCollectionItems);
    const values: CborValue[] = [];
    for (let index = 0; index < length; index += 1) {
      values.push(this.readValue(depth + 1));
    }
    return values;
  }

  private readMap(
    additional: number,
    depth: number,
  ): Map<CborMapKey, CborValue> {
    const length = this.readLength(additional, maximumCollectionItems);
    const values = new Map<CborMapKey, CborValue>();
    const identities = new Set<string>();
    for (let index = 0; index < length; index += 1) {
      const rawKey = this.readValue(depth + 1);
      if (
        typeof rawKey !== "number" &&
        typeof rawKey !== "string" &&
        !Buffer.isBuffer(rawKey)
      ) {
        throw new CborDecodingError();
      }
      const identity = mapKeyIdentity(rawKey);
      if (identities.has(identity)) throw new CborDecodingError();
      identities.add(identity);
      values.set(rawKey, this.readValue(depth + 1));
    }
    return values;
  }

  private readBytes(additional: number, maximum: number): Buffer {
    const length = this.readLength(additional, maximum);
    if (this.offset + length > this.input.length) {
      throw new CborDecodingError();
    }
    const value = this.input.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  private readLength(additional: number, maximum: number): number {
    const length = this.readUnsigned(additional);
    if (length > maximum) throw new CborDecodingError();
    return length;
  }

  private readUnsigned(additional: number): number {
    if (additional < 24) return additional;
    if (additional === 24) {
      const value = this.readByte();
      if (value < 24) throw new CborDecodingError();
      return value;
    }
    if (additional === 25) {
      const value = this.readIntegerBytes(2);
      if (value <= 0xff) throw new CborDecodingError();
      return value;
    }
    if (additional === 26) {
      const value = this.readIntegerBytes(4);
      if (value <= 0xffff) throw new CborDecodingError();
      return value;
    }
    if (additional === 27) {
      const value = this.readIntegerBytes(8);
      if (value <= 0xffff_ffff) throw new CborDecodingError();
      return value;
    }
    // Indefinite-length CBOR and reserved additional-information values are
    // rejected so an attacker cannot smuggle alternate representations.
    throw new CborDecodingError();
  }

  private readIntegerBytes(length: number): number {
    if (this.offset + length > this.input.length) {
      throw new CborDecodingError();
    }
    let value = 0n;
    for (let index = 0; index < length; index += 1) {
      value = (value << 8n) | BigInt(this.input[this.offset + index] ?? 0);
    }
    this.offset += length;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CborDecodingError();
    }
    return Number(value);
  }

  private readByte(): number {
    const value = this.input[this.offset];
    if (value === undefined) throw new CborDecodingError();
    this.offset += 1;
    return value;
  }
}

function mapKeyIdentity(key: CborMapKey): string {
  if (typeof key === "number") return `number:${key}`;
  if (typeof key === "string") return `string:${key}`;
  return `bytes:${key.toString("base64")}`;
}

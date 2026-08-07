import { describe, expect, it } from "vitest";

import { CborDecodingError, decodeCborExact } from "./app-attest-cbor.js";

describe("strict App Attest CBOR decoding", () => {
  it.each([
    ["trailing data", Buffer.from([0x01, 0x01])],
    ["indefinite length", Buffer.from([0x9f, 0xff])],
    ["non-canonical integer", Buffer.from([0x18, 0x01])],
    [
      "duplicate map key",
      Buffer.from([0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02]),
    ],
    ["unsupported tag", Buffer.from([0xc0, 0x01])],
  ])("rejects %s", (_name, encoded) => {
    expect(() => decodeCborExact(encoded)).toThrow(CborDecodingError);
  });

  it("decodes the bounded primitive types used by App Attest", () => {
    const decoded = decodeCborExact(
      Buffer.from([0xa2, 0x61, 0x61, 0x01, 0x61, 0x62, 0x42, 0x01, 0x02]),
    );
    expect(decoded).toBeInstanceOf(Map);
    expect((decoded as Map<string, unknown>).get("a")).toBe(1);
    expect((decoded as Map<string, unknown>).get("b")).toEqual(
      Buffer.from([1, 2]),
    );
  });
});

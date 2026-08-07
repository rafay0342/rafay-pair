import { describe, expect, it } from "vitest";

import {
  createCsrfToken,
  createJoinCode,
  hashPassword,
  opaqueToken,
  tokenHash,
  verifyCsrfSignature,
  verifyPassword,
} from "./security.js";

const pepper = "test-pepper-that-is-longer-than-thirty-two-bytes";

describe("security primitives", () => {
  it("uses high-entropy opaque credentials and keyed database hashes", () => {
    const token = opaqueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHash(token, pepper)).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenHash(token, `${pepper}-different`)).not.toBe(
      tokenHash(token, pepper),
    );
  });

  it("signs anonymous CSRF tokens", () => {
    const token = createCsrfToken(pepper);
    expect(verifyCsrfSignature(token, pepper)).toBe(true);
    expect(verifyCsrfSignature(`${token}x`, pepper)).toBe(false);
  });

  it("creates unambiguous eight-character pair codes", () => {
    expect(createJoinCode()).toMatch(/^[A-Z2-9]{8}$/);
  });

  it("hashes passwords with Argon2id", async () => {
    const hash = await hashPassword("a-production-password-42");
    expect(hash).toContain("$argon2id$");
    await expect(
      verifyPassword(hash, "a-production-password-42"),
    ).resolves.toBe(true);
    await expect(verifyPassword(hash, "wrong-password-42")).resolves.toBe(
      false,
    );
  });
});

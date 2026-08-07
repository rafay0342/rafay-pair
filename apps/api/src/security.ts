import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import argon2 from "argon2";

export const accessTokenLifetimeMs = 15 * 60 * 1_000;
export const refreshTokenLifetimeMs = 30 * 24 * 60 * 60 * 1_000;

export function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenHash(token: string, pepper: string): string {
  return createHmac("sha256", pepper).update(token).digest("hex");
}

export function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
    hashLength: 32,
  });
}

export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(passwordHash, password);
  } catch {
    return false;
  }
}

const joinAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function createJoinCode(): string {
  const bytes = randomBytes(8);
  return Array.from(
    bytes,
    (byte) => joinAlphabet[byte % joinAlphabet.length],
  ).join("");
}

export function createCsrfToken(pepper: string): string {
  const nonce = opaqueToken();
  return `${nonce}.${tokenHash(nonce, pepper)}`;
}

export function verifyCsrfSignature(value: string, pepper: string): boolean {
  const separator = value.indexOf(".");
  if (separator < 1) return false;
  const nonce = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  return secureEqual(signature, tokenHash(nonce, pepper));
}

import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
  X509Certificate,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";

import {
  assertOnlyMapKeys,
  CborDecodingError,
  decodeCborExact,
  decodeCborFirst,
  requireCborArray,
  requireCborBytes,
  requireCborInteger,
  requireCborMap,
  requireCborText,
  requireMapValue,
  type CborMapKey,
  type CborValue,
} from "./app-attest-cbor.js";
import { DerDecodingError, extractAppAttestNonce } from "./app-attest-der.js";

export type AppAttestEnvironment = "development" | "production";

export interface AppAttestVerifierConfiguration {
  appId: string;
  environment: AppAttestEnvironment;
  allowedValidationCategories: ReadonlySet<number>;
  allowedBundleVersions: ReadonlySet<string>;
}

export interface VerifiedAppAttestation {
  publicKeySpki: Buffer;
  receipt: Buffer;
  counter: 0;
  environment: AppAttestEnvironment;
  validationCategory?: number;
  bundleVersion?: string;
  signal: "low_risk" | "elevated_risk";
  metadata: Record<string, unknown>;
}

export interface VerifiedAppAssertion {
  counter: number;
  validationCategory?: number;
  bundleVersion?: string;
  signal: "low_risk" | "elevated_risk";
  metadata: Record<string, unknown>;
}

export type AppAttestVerificationFailure =
  | "malformed_object"
  | "invalid_certificate_chain"
  | "invalid_nonce"
  | "invalid_app_identity"
  | "invalid_environment"
  | "invalid_key_binding"
  | "invalid_counter"
  | "invalid_signature"
  | "invalid_extensions";

export class AppAttestVerificationError extends Error {
  public constructor(public readonly reason: AppAttestVerificationFailure) {
    super("App Attest verification failed");
    this.name = "AppAttestVerificationError";
  }
}

const appleAppAttestationRootCertificate = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;

const nonceExtensionOid = "1.2.840.113635.100.8.2";
const productionAaguid = Buffer.concat([
  Buffer.from("appattest", "ascii"),
  Buffer.alloc(7),
]);
const developmentAaguid = Buffer.from("appattestdevelop", "ascii");
const sandboxAaguid = Buffer.from("appattestsandbox", "ascii");
const validationCategoryKey = "apple_validation_category_01";
const bundleVersionKey = "apple_bundle_version_01";
const maximumAttestationObjectBytes = 64 * 1_024;
const maximumAssertionObjectBytes = 16 * 1_024;
const maximumReceiptBytes = 48 * 1_024;

export function verifyAppAttestation(
  input: {
    attestationObject: Buffer;
    keyId: string;
    clientDataHash: Buffer;
  },
  configuration: AppAttestVerifierConfiguration,
  now = new Date(),
): VerifiedAppAttestation {
  validateConfiguration(configuration);
  if (
    input.attestationObject.length === 0 ||
    input.attestationObject.length > maximumAttestationObjectBytes ||
    input.clientDataHash.length !== 32
  ) {
    throw new AppAttestVerificationError("malformed_object");
  }

  try {
    const decoded = requireCborMap(decodeCborExact(input.attestationObject));
    assertOnlyMapKeys(decoded, ["fmt", "attStmt", "authData"]);
    if (
      requireCborText(requireMapValue(decoded, "fmt")) !== "apple-appattest"
    ) {
      throw new AppAttestVerificationError("malformed_object");
    }
    const statement = requireCborMap(requireMapValue(decoded, "attStmt"));
    assertOnlyMapKeys(statement, ["x5c", "receipt"]);
    const certificateValues = requireCborArray(
      requireMapValue(statement, "x5c"),
    );
    if (certificateValues.length < 2 || certificateValues.length > 4) {
      throw new AppAttestVerificationError("invalid_certificate_chain");
    }
    const certificates = certificateValues.map((value) =>
      parseCertificate(requireCborBytes(value)),
    );
    verifyCertificateChain(certificates, now);
    const leaf = certificates[0];
    if (!leaf) {
      throw new AppAttestVerificationError("invalid_certificate_chain");
    }
    const receipt = requireCborBytes(requireMapValue(statement, "receipt"));
    if (receipt.length < 64 || receipt.length > maximumReceiptBytes) {
      throw new AppAttestVerificationError("malformed_object");
    }
    const authData = requireCborBytes(requireMapValue(decoded, "authData"));
    const parsedAuthData = parseAttestationAuthenticatorData(authData);
    verifyRelyingParty(parsedAuthData.rpIdHash, configuration.appId);
    if (parsedAuthData.counter !== 0) {
      throw new AppAttestVerificationError("invalid_counter");
    }
    verifyEnvironment(parsedAuthData.aaguid, configuration.environment);

    const decodedKeyId = decodeKeyId(input.keyId);
    if (!safeEqual(parsedAuthData.credentialId, decodedKeyId)) {
      throw new AppAttestVerificationError("invalid_key_binding");
    }
    const publicKey = requireP256PublicKey(leaf.publicKey);
    const uncompressedPoint = Buffer.concat([
      Buffer.from([0x04]),
      publicKey.x,
      publicKey.y,
    ]);
    if (!safeEqual(sha256(uncompressedPoint), decodedKeyId)) {
      throw new AppAttestVerificationError("invalid_key_binding");
    }
    verifyCoseKey(parsedAuthData.coseKey, publicKey);

    const expectedNonce = sha256(
      Buffer.concat([authData, input.clientDataHash]),
    );
    const certificateNonce = extractAppAttestNonce(leaf.raw);
    if (!safeEqual(certificateNonce, expectedNonce)) {
      throw new AppAttestVerificationError("invalid_nonce");
    }

    const extensions = evaluateExtensions(
      parsedAuthData.extensions,
      configuration,
    );
    return {
      publicKeySpki: leaf.publicKey.export({ type: "spki", format: "der" }),
      receipt: Buffer.from(receipt),
      counter: 0,
      environment: configuration.environment,
      ...(extensions.validationCategory === undefined
        ? {}
        : { validationCategory: extensions.validationCategory }),
      ...(extensions.bundleVersion === undefined
        ? {}
        : { bundleVersion: extensions.bundleVersion }),
      signal: extensions.signal,
      metadata: extensions.metadata,
    };
  } catch (error) {
    throw normalizeVerificationError(error);
  }
}

export function verifyAppAssertion(
  input: {
    assertionObject: Buffer;
    clientData: Buffer;
    publicKeySpki: Buffer;
    previousCounter: number;
  },
  configuration: AppAttestVerifierConfiguration,
): VerifiedAppAssertion {
  validateConfiguration(configuration);
  if (
    input.assertionObject.length === 0 ||
    input.assertionObject.length > maximumAssertionObjectBytes ||
    input.clientData.length === 0 ||
    input.clientData.length > 4 * 1_024 ||
    input.publicKeySpki.length === 0 ||
    input.publicKeySpki.length > 512 ||
    !Number.isSafeInteger(input.previousCounter) ||
    input.previousCounter < 0 ||
    input.previousCounter > 0xffff_ffff
  ) {
    throw new AppAttestVerificationError("malformed_object");
  }

  try {
    const decoded = requireCborMap(decodeCborExact(input.assertionObject));
    assertOnlyMapKeys(decoded, ["signature", "authenticatorData"]);
    const signature = requireCborBytes(requireMapValue(decoded, "signature"));
    const authData = requireCborBytes(
      requireMapValue(decoded, "authenticatorData"),
    );
    if (signature.length < 64 || signature.length > 80) {
      throw new AppAttestVerificationError("invalid_signature");
    }
    const parsedAuthData = parseAssertionAuthenticatorData(authData);
    verifyRelyingParty(parsedAuthData.rpIdHash, configuration.appId);
    if (
      parsedAuthData.counter === 0 ||
      parsedAuthData.counter <= input.previousCounter
    ) {
      throw new AppAttestVerificationError("invalid_counter");
    }
    const publicKey = createPublicKey({
      key: input.publicKeySpki,
      type: "spki",
      format: "der",
    });
    requireP256PublicKey(publicKey);
    const clientDataHash = sha256(input.clientData);
    // App Attest signs SHA256(authenticatorData || clientDataHash). Passing the
    // unhashed composite to Node's SHA-256 verifier avoids hashing that digest
    // a second time.
    const signedData = Buffer.concat([authData, clientDataHash]);
    if (!verifySignature("sha256", signedData, publicKey, signature)) {
      throw new AppAttestVerificationError("invalid_signature");
    }
    const extensions = evaluateExtensions(
      parsedAuthData.extensions,
      configuration,
    );
    return {
      counter: parsedAuthData.counter,
      ...(extensions.validationCategory === undefined
        ? {}
        : { validationCategory: extensions.validationCategory }),
      ...(extensions.bundleVersion === undefined
        ? {}
        : { bundleVersion: extensions.bundleVersion }),
      signal: extensions.signal,
      metadata: extensions.metadata,
    };
  } catch (error) {
    throw normalizeVerificationError(error);
  }
}

interface ParsedExtensions {
  validationCategory?: number;
  bundleVersion?: string;
}

interface ParsedAuthenticatorHeader {
  rpIdHash: Buffer;
  counter: number;
  remainder: Buffer;
}

function parseAttestationAuthenticatorData(authData: Buffer): {
  rpIdHash: Buffer;
  counter: number;
  aaguid: Buffer;
  credentialId: Buffer;
  coseKey: Map<CborMapKey, CborValue>;
  extensions: ParsedExtensions;
} {
  const header = parseAuthenticatorHeader(authData);
  if (header.remainder.length < 18) {
    throw new AppAttestVerificationError("malformed_object");
  }
  const aaguid = header.remainder.subarray(0, 16);
  const credentialLength = header.remainder.readUInt16BE(16);
  if (
    credentialLength !== 32 ||
    header.remainder.length < 18 + credentialLength
  ) {
    throw new AppAttestVerificationError("invalid_key_binding");
  }
  const credentialId = header.remainder.subarray(18, 18 + credentialLength);
  const encodedKeyAndExtensions = header.remainder.subarray(
    18 + credentialLength,
  );
  const decodedKey = decodeCborFirst(encodedKeyAndExtensions);
  const coseKey = requireCborMap(decodedKey.value);
  const encodedExtensions = encodedKeyAndExtensions.subarray(
    decodedKey.bytesRead,
  );
  return {
    rpIdHash: header.rpIdHash,
    counter: header.counter,
    aaguid,
    credentialId,
    coseKey,
    extensions: parseExtensions(encodedExtensions),
  };
}

function parseAssertionAuthenticatorData(authData: Buffer): {
  rpIdHash: Buffer;
  counter: number;
  extensions: ParsedExtensions;
} {
  const header = parseAuthenticatorHeader(authData);
  return {
    rpIdHash: header.rpIdHash,
    counter: header.counter,
    extensions: parseExtensions(header.remainder),
  };
}

function parseAuthenticatorHeader(authData: Buffer): ParsedAuthenticatorHeader {
  if (authData.length < 37 || authData.length > 4 * 1_024) {
    throw new AppAttestVerificationError("malformed_object");
  }
  return {
    rpIdHash: authData.subarray(0, 32),
    counter: authData.readUInt32BE(33),
    remainder: authData.subarray(37),
  };
}

function parseExtensions(encoded: Buffer): ParsedExtensions {
  if (encoded.length === 0) return {};
  const map = requireCborMap(decodeCborExact(encoded));
  const categoryValue = map.get(validationCategoryKey);
  const bundleVersionValue = map.get(bundleVersionKey);
  if ((categoryValue === undefined) !== (bundleVersionValue === undefined)) {
    throw new AppAttestVerificationError("invalid_extensions");
  }
  if (categoryValue === undefined || bundleVersionValue === undefined)
    return {};
  const validationCategory = decodeValidationCategory(categoryValue);
  const bundleVersion = requireCborText(bundleVersionValue);
  if (
    validationCategory < 1 ||
    validationCategory > 6 ||
    bundleVersion.length === 0 ||
    bundleVersion.length > 64 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(bundleVersion)
  ) {
    throw new AppAttestVerificationError("invalid_extensions");
  }
  return { validationCategory, bundleVersion };
}

function decodeValidationCategory(value: CborValue): number {
  if (typeof value === "number") return requireCborInteger(value);
  const bytes = requireCborBytes(value);
  if (bytes.length !== 4) {
    throw new AppAttestVerificationError("invalid_extensions");
  }
  return bytes.readUInt32LE(0);
}

function evaluateExtensions(
  extensions: ParsedExtensions,
  configuration: AppAttestVerifierConfiguration,
): {
  validationCategory?: number;
  bundleVersion?: string;
  signal: "low_risk" | "elevated_risk";
  metadata: Record<string, unknown>;
} {
  const { validationCategory, bundleVersion } = extensions;
  const extensionsAvailable =
    validationCategory !== undefined && bundleVersion !== undefined;
  const categoryExpected =
    validationCategory !== undefined &&
    configuration.allowedValidationCategories.has(validationCategory);
  const bundleVersionExpected =
    bundleVersion !== undefined &&
    configuration.allowedBundleVersions.has(bundleVersion);
  return {
    ...(validationCategory === undefined ? {} : { validationCategory }),
    ...(bundleVersion === undefined ? {} : { bundleVersion }),
    signal:
      extensionsAvailable && categoryExpected && bundleVersionExpected
        ? "low_risk"
        : "elevated_risk",
    metadata: {
      environment: configuration.environment,
      extensionsAvailable,
      categoryExpected,
      bundleVersionExpected,
      ...(validationCategory === undefined ? {} : { validationCategory }),
      ...(bundleVersion === undefined ? {} : { bundleVersion }),
    },
  };
}

function verifyCertificateChain(
  certificates: readonly X509Certificate[],
  now: Date,
): void {
  const root = new X509Certificate(appleAppAttestationRootCertificate);
  const suppliedFingerprints = new Set<string>();
  for (const certificate of certificates) {
    if (
      safeEqual(certificate.raw, root.raw) ||
      suppliedFingerprints.has(certificate.fingerprint256)
    ) {
      // x5c must omit the trust anchor. Rejecting duplicate certificates also
      // prevents a self-signed root from being repeated to pad a valid chain.
      throw new AppAttestVerificationError("invalid_certificate_chain");
    }
    suppliedFingerprints.add(certificate.fingerprint256);
  }
  const all = [...certificates, root];
  for (let index = 0; index < all.length; index += 1) {
    const certificate = all[index];
    if (
      !certificate ||
      now < certificate.validFromDate ||
      now > certificate.validToDate
    ) {
      throw new AppAttestVerificationError("invalid_certificate_chain");
    }
    if (index === 0 && certificate.ca) {
      throw new AppAttestVerificationError("invalid_certificate_chain");
    }
    if (index > 0 && !certificate.ca) {
      throw new AppAttestVerificationError("invalid_certificate_chain");
    }
  }
  for (let index = 0; index < all.length - 1; index += 1) {
    const certificate = all[index];
    const issuer = all[index + 1];
    if (
      !certificate ||
      !issuer ||
      certificate.issuer !== issuer.subject ||
      !certificate.verify(issuer.publicKey)
    ) {
      throw new AppAttestVerificationError("invalid_certificate_chain");
    }
  }
}

function parseCertificate(encoded: Buffer): X509Certificate {
  if (encoded.length < 256 || encoded.length > 8 * 1_024) {
    throw new AppAttestVerificationError("invalid_certificate_chain");
  }
  try {
    return new X509Certificate(encoded);
  } catch {
    throw new AppAttestVerificationError("invalid_certificate_chain");
  }
}

function verifyCoseKey(
  coseKey: Map<CborMapKey, CborValue>,
  publicKey: { x: Buffer; y: Buffer },
): void {
  assertOnlyMapKeys(coseKey, [1, 3, -1, -2, -3]);
  if (
    requireCborInteger(requireMapValue(coseKey, 1)) !== 2 ||
    requireCborInteger(requireMapValue(coseKey, 3)) !== -7 ||
    requireCborInteger(requireMapValue(coseKey, -1)) !== 1 ||
    !safeEqual(requireCborBytes(requireMapValue(coseKey, -2)), publicKey.x) ||
    !safeEqual(requireCborBytes(requireMapValue(coseKey, -3)), publicKey.y)
  ) {
    throw new AppAttestVerificationError("invalid_key_binding");
  }
}

function requireP256PublicKey(publicKey: KeyObject): { x: Buffer; y: Buffer } {
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  if (
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    typeof jwk.x !== "string" ||
    typeof jwk.y !== "string"
  ) {
    throw new AppAttestVerificationError("invalid_key_binding");
  }
  const x = decodeBase64Url(jwk.x);
  const y = decodeBase64Url(jwk.y);
  if (x.length !== 32 || y.length !== 32) {
    throw new AppAttestVerificationError("invalid_key_binding");
  }
  return { x, y };
}

function verifyRelyingParty(rpIdHash: Buffer, appId: string): void {
  if (!safeEqual(rpIdHash, sha256(Buffer.from(appId, "utf8")))) {
    throw new AppAttestVerificationError("invalid_app_identity");
  }
}

function verifyEnvironment(
  aaguid: Buffer,
  environment: AppAttestEnvironment,
): void {
  const expected =
    environment === "production"
      ? [productionAaguid]
      : [developmentAaguid, sandboxAaguid];
  if (!expected.some((value) => safeEqual(aaguid, value))) {
    throw new AppAttestVerificationError("invalid_environment");
  }
}

function decodeKeyId(keyId: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(keyId)) {
    throw new AppAttestVerificationError("invalid_key_binding");
  }
  const decoded = Buffer.from(keyId, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== keyId) {
    throw new AppAttestVerificationError("invalid_key_binding");
  }
  return decoded;
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new AppAttestVerificationError("invalid_key_binding");
  }
  return Buffer.from(value, "base64url");
}

function validateConfiguration(
  configuration: AppAttestVerifierConfiguration,
): void {
  if (
    !/^[A-Z0-9]{10}\.[A-Za-z0-9.-]{3,255}$/u.test(configuration.appId) ||
    configuration.allowedValidationCategories.size === 0 ||
    configuration.allowedBundleVersions.size === 0
  ) {
    throw new Error("Invalid App Attest verifier configuration");
  }
}

function sha256(input: Buffer): Buffer {
  return createHash("sha256").update(input).digest();
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeVerificationError(
  error: unknown,
): AppAttestVerificationError {
  if (error instanceof AppAttestVerificationError) return error;
  if (
    error instanceof CborDecodingError ||
    error instanceof DerDecodingError ||
    error instanceof TypeError ||
    error instanceof RangeError
  ) {
    return new AppAttestVerificationError("malformed_object");
  }
  return new AppAttestVerificationError("malformed_object");
}

// Exported only for pin-rotation tests and deployment verification. This value
// is Apple's public trust anchor, not an application secret.
export const appleAppAttestationRootFingerprint = new X509Certificate(
  appleAppAttestationRootCertificate,
).fingerprint256;

// Referencing the OID here makes accidental deletion of the nonce validation
// visible to static review without exposing it in public error responses.
export const appAttestNonceExtensionOid = nonceExtensionOid;

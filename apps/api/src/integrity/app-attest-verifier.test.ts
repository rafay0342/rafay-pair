import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AppAttestVerificationError,
  appleAppAttestationRootFingerprint,
  verifyAppAssertion,
  verifyAppAttestation,
  type AppAttestVerifierConfiguration,
} from "./app-attest-verifier.js";

const sampleAppId = "1234567890.com.example.myapp";
const sampleKeyId = "zgSY9YSD+7TaDXssY6WlOPVS1K3Lmk+pFhlcSWE+ZV0=";
const sampleLeafCertificate = Buffer.from(
  "MIIEHTCCA6OgAwIBAgIGAZ2xPwtOMAoGCCqGSM49BAMCME8xIzAhBgNVBAMMGkFwcGxlIEFwcCBBdHRlc3RhdGlvbiBDQSAxMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMB4XDTI2MDQyMDE4MTMxMloXDTI2MDQyMzE4MTMxMlowgZExSTBHBgNVBAMMQGNlMDQ5OGY1ODQ4M2ZiYjRkYTBkN2IyYzYzYTVhNTM4ZjU1MmQ0YWRjYjlhNGZhOTE2MTk1YzQ5NjEzZTY1NWQxGjAYBgNVBAsMEUFBQSBDZXJ0aWZpY2F0aW9uMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEQzJUSs8yPbd0RDyq8zn1bn6VxyT6wsFCWfNl4kRWULK1+yhbz1Sby2BZRBLnaCokJ+6tqftS3+0LGrF+0J+pvaOCAiYwggIiMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQDAgTwMBQGA1UdJQQNMAsGCSqGSIb3Y2QEGDB6BgkqhkiG92NkCAUEbTBrpAMCAQq/iTADAgEAv4kxAwIBAL+JMgMCAQC/iTMDAgEAv4k0HgQcMTIzNDU2Nzg5MC5jb20uZXhhbXBsZS5teWFwcL+JNgMCAQS/iTcDAgEAv4k5AwIBAL+JOgMCAQC/iTsDAgEAqgMCAQAwgeAGCSqGSIb3Y2QIBwSB0jCBz7+KeAYEBDI3LjC/iFADAgECv4p5CQQHMS4wLjIxNr+KewkEBzI0QTMyNWK/inwGBAQyNy4wv4p9BgQEMjcuML+KfgMCAQC/in8DAgEAv4sAAwIBAL+LAQMCAQC/iwIDAgEAv4sDAwIBAL+LBAMCAQG/iwUDAgEAv4sKEAQOMjQuMS4zMjUuMC4yLDC/iwsQBA4yNC4xLjMyNS4wLjIsML+LDBAEDjI0LjEuMzI1LjAuMiwwv4gCCgQIaXBob25lb3O/iAUKBAhJbnRlcm5hbDAzBgkqhkiG92NkCAIEJjAkoSIEIIe30G2TpClORvAR5mtsxADwurIHKZdsYZWAtCrmC/9uMFgGCSqGSIb3Y2QIBgRLMEmjRwRFMEMMAjExMD0wCgwDb2tkoQMBAf8wCQwCb2GhAwEB/zALDARvc2duoQMBAf8wCwwEb2RlbKEDAQH/MAoMA29ja6EDAQH/MAoGCCqGSM49BAMCA2gAMGUCMCG8x2j20SnJtrGuCbw1sk1+NMs/VNm8sRcU4aPhyDNB3mMBdxy8gNza6r91g8v1HQIxAKTqMS+83kFdMob2rD3t9fnNWWLhA8RFOqw64XhXFTEWXqb1ddPoRcYCFlTEqULtPQ==",
  "base64",
);
const sampleIntermediateCertificate = Buffer.from(
  "MIICQzCCAcigAwIBAgIQCbrF4bxAGtnUU5W8OBoIVDAKBggqhkjOPQQDAzBSMSYwJAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODM5NTVaFw0zMDAzMTMwMDAwMDBaME8xIzAhBgNVBAMMGkFwcGxlIEFwcCBBdHRlc3RhdGlvbiBDQSAxMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAErls3oHdNebI1j0Dn0fImJvHCX+8XgC3qs4JqWYdP+NKtFSV4mqJmBBkSSLY8uWcGnpjTY71eNw+/oI4ynoBzqYXndG6jWaL2bynbMq9FXiEWWNVnr54mfrJhTcIaZs6Zo2YwZDASBgNVHRMBAf8ECDAGAQH/AgEAMB8GA1UdIwQYMBaAFKyREFMzvb5oQf+nDKnl+url5YqhMB0GA1UdDgQWBBQ+410cBBmpybQx+IR01uHhV3LjmzAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwMDaQAwZgIxALu+iI1zjQUCz7z9Zm0JV1A1vNaHLD+EMEkmKe3R+RToeZkcmui1rvjTqFQz97YNBgIxAKs47dDMge0ApFLDukT5k2NlU/7MKX8utN+fXr5aSsq2mVxLgg35BDhveAe7WJQ5tw==",
  "base64",
);
const sampleComposite = Buffer.from(
  "9EZtaPketsEGIMt+Y8coMkRoXuHWRntUFg51MXIFfwNAAAAAAGFwcGF0dGVzdAAAAAAAAAAAIM4EmPWEg/u02g17LGOlpTj1UtSty5pPqRYZXElhPmVdpQECAyYgASFYIEMyVErPMj23dEQ8qvM59W5+lcck+sLBQlnzZeJEVlCyIlggtfsoW89Um8tgWUQS52gqJCfuran7Ut/tCxqxftCfqb2id2FwcGxlX2J1bmRsZV92ZXJzaW9uXzAxYTF4HGFwcGxlX3ZhbGlkYXRpb25fY2F0ZWdvcnlfMDFEAQAAAGV4YW1wbGVfc2VydmVyX2NoYWxsZW5nZQ==",
  "base64",
);
const sampleClientDataHash = Buffer.from("example_server_challenge", "utf8");
const sampleAuthData = sampleComposite.subarray(
  0,
  sampleComposite.length - sampleClientDataHash.length,
);

const sampleConfiguration: AppAttestVerifierConfiguration = {
  appId: sampleAppId,
  environment: "production",
  allowedValidationCategories: new Set([1]),
  allowedBundleVersions: new Set(["1"]),
};

describe("App Attest attestation verification", () => {
  it("pins Apple's published App Attest root certificate", () => {
    expect(appleAppAttestationRootFingerprint).toMatch(
      /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/u,
    );
  });

  it("requires a SHA-256 client-data hash", () => {
    // Apple's guide's current downloadable vector appends the literal sample
    // challenge even though the accompanying validation steps require its
    // SHA-256 digest. Production accepts only the protocol's 32-byte hash.
    expect(() =>
      verifyAppAttestation(
        {
          attestationObject: sampleAttestationObject(),
          keyId: sampleKeyId,
          clientDataHash: sampleClientDataHash,
        },
        sampleConfiguration,
        new Date("2026-04-21T18:13:12.500Z"),
      ),
    ).toThrowError(expect.objectContaining({ reason: "malformed_object" }));
  });

  it.each([
    [
      "nonce",
      () =>
        verifyAppAttestation(
          {
            attestationObject: sampleAttestationObject(),
            keyId: sampleKeyId,
            clientDataHash: sha256(
              Buffer.from("different_server_challenge", "utf8"),
            ),
          },
          sampleConfiguration,
          new Date("2026-04-21T18:13:12.500Z"),
        ),
      "invalid_nonce",
    ],
    [
      "App ID",
      () =>
        verifyAppAttestation(
          {
            attestationObject: sampleAttestationObject(),
            keyId: sampleKeyId,
            clientDataHash: sha256(sampleClientDataHash),
          },
          { ...sampleConfiguration, appId: "1234567890.com.example.other" },
          new Date("2026-04-21T18:13:12.500Z"),
        ),
      "invalid_app_identity",
    ],
    [
      "key binding",
      () =>
        verifyAppAttestation(
          {
            attestationObject: sampleAttestationObject(),
            keyId: Buffer.alloc(32, 7).toString("base64"),
            clientDataHash: sha256(sampleClientDataHash),
          },
          sampleConfiguration,
          new Date("2026-04-21T18:13:12.500Z"),
        ),
      "invalid_key_binding",
    ],
    [
      "environment",
      () =>
        verifyAppAttestation(
          {
            attestationObject: sampleAttestationObject(),
            keyId: sampleKeyId,
            clientDataHash: sha256(sampleClientDataHash),
          },
          { ...sampleConfiguration, environment: "development" as const },
          new Date("2026-04-21T18:13:12.500Z"),
        ),
      "invalid_environment",
    ],
    [
      "certificate validity",
      () =>
        verifyAppAttestation(
          {
            attestationObject: sampleAttestationObject(),
            keyId: sampleKeyId,
            clientDataHash: sha256(sampleClientDataHash),
          },
          sampleConfiguration,
          new Date("2026-08-07T00:00:00Z"),
        ),
      "invalid_certificate_chain",
    ],
  ])(
    "rejects an invalid %s without exposing proof material",
    (_name, operation, reason) => {
      expect(operation).toThrowError(
        expect.objectContaining({
          message: "App Attest verification failed",
          reason,
        }),
      );
    },
  );

  it("rejects a chain that is not ordered leaf-to-Apple-root", () => {
    const object = encodeCbor(
      new Map<string, Encodable>([
        ["fmt", "apple-appattest"],
        [
          "attStmt",
          new Map<string, Encodable>([
            ["x5c", [sampleIntermediateCertificate, sampleLeafCertificate]],
            ["receipt", Buffer.alloc(128, 1)],
          ]),
        ],
        ["authData", sampleAuthData],
      ]),
    );
    expect(() =>
      verifyAppAttestation(
        {
          attestationObject: object,
          keyId: sampleKeyId,
          clientDataHash: sha256(sampleClientDataHash),
        },
        sampleConfiguration,
        new Date("2026-04-21T18:13:12.500Z"),
      ),
    ).toThrowError(
      expect.objectContaining({ reason: "invalid_certificate_chain" }),
    );
  });
});

describe("App Attest assertion verification", () => {
  it("verifies the signature and accepts only a strictly increasing counter", () => {
    const fixture = assertionFixture(1, true);
    const verified = verifyAppAssertion(
      {
        assertionObject: fixture.assertionObject,
        clientData: fixture.clientData,
        publicKeySpki: fixture.publicKeySpki,
        previousCounter: 0,
      },
      fixture.configuration,
    );
    expect(verified.counter).toBe(1);
    expect(verified.signal).toBe("low_risk");

    expect(() =>
      verifyAppAssertion(
        {
          assertionObject: fixture.assertionObject,
          clientData: fixture.clientData,
          publicKeySpki: fixture.publicKeySpki,
          previousCounter: 1,
        },
        fixture.configuration,
      ),
    ).toThrowError(expect.objectContaining({ reason: "invalid_counter" }));
  });

  it("rejects client-data tampering and the wrong relying-party identity", () => {
    const fixture = assertionFixture(4, true);
    expect(() =>
      verifyAppAssertion(
        {
          assertionObject: fixture.assertionObject,
          clientData: Buffer.from("tampered", "utf8"),
          publicKeySpki: fixture.publicKeySpki,
          previousCounter: 3,
        },
        fixture.configuration,
      ),
    ).toThrowError(expect.objectContaining({ reason: "invalid_signature" }));

    expect(() =>
      verifyAppAssertion(
        {
          assertionObject: fixture.assertionObject,
          clientData: fixture.clientData,
          publicKeySpki: fixture.publicKeySpki,
          previousCounter: 3,
        },
        { ...fixture.configuration, appId: "ABCDEFGHIJ.com.rafaypair.other" },
      ),
    ).toThrowError(expect.objectContaining({ reason: "invalid_app_identity" }));
  });

  it("keeps valid pre-extension assertions as an elevated risk signal", () => {
    const fixture = assertionFixture(1, false);
    const verified = verifyAppAssertion(
      {
        assertionObject: fixture.assertionObject,
        clientData: fixture.clientData,
        publicKeySpki: fixture.publicKeySpki,
        previousCounter: 0,
      },
      fixture.configuration,
    );
    expect(verified.signal).toBe("elevated_risk");
    expect(verified.metadata).toMatchObject({ extensionsAvailable: false });
  });
});

function sampleAttestationObject(): Buffer {
  return encodeCbor(
    new Map<string, Encodable>([
      ["fmt", "apple-appattest"],
      [
        "attStmt",
        new Map<string, Encodable>([
          ["x5c", [sampleLeafCertificate, sampleIntermediateCertificate]],
          // The receipt is opaque to key attestation validation and is retained
          // for Apple's separate server-to-server fraud metric flow.
          ["receipt", Buffer.alloc(128, 1)],
        ]),
      ],
      ["authData", sampleAuthData],
    ]),
  );
}

function assertionFixture(
  counter: number,
  includeExtensions: boolean,
): {
  assertionObject: Buffer;
  clientData: Buffer;
  publicKeySpki: Buffer;
  configuration: AppAttestVerifierConfiguration;
} {
  const appId = "ABCDEFGHIJ.com.rafaypair.app";
  const configuration: AppAttestVerifierConfiguration = {
    appId,
    environment: "production",
    allowedValidationCategories: new Set([4]),
    allowedBundleVersions: new Set(["1"]),
  };
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const counterBytes = Buffer.alloc(4);
  counterBytes.writeUInt32BE(counter);
  const extensions = includeExtensions
    ? encodeCbor(
        new Map<string, Encodable>([
          ["apple_validation_category_01", uint32LittleEndian(4)],
          ["apple_bundle_version_01", "1"],
        ]),
      )
    : Buffer.alloc(0);
  const authData = Buffer.concat([
    sha256(Buffer.from(appId, "utf8")),
    Buffer.from([0]),
    counterBytes,
    extensions,
  ]);
  const clientData = Buffer.from(
    '{"action":"session_start","challenge":"server-controlled"}',
    "utf8",
  );
  const signedData = Buffer.concat([authData, sha256(clientData)]);
  const signature = sign("sha256", signedData, privateKey);
  return {
    assertionObject: encodeCbor(
      new Map<string, Encodable>([
        ["signature", signature],
        ["authenticatorData", authData],
      ]),
    ),
    clientData,
    publicKeySpki: publicKey.export({ type: "spki", format: "der" }),
    configuration,
  };
}

type Encodable =
  | null
  | boolean
  | number
  | string
  | Buffer
  | Encodable[]
  | Map<number | string, Encodable>;

function encodeCbor(value: Encodable): Buffer {
  if (value === null) return Buffer.from([0xf6]);
  if (typeof value === "boolean") return Buffer.from([value ? 0xf5 : 0xf4]);
  if (typeof value === "number") {
    return value >= 0
      ? encodeTypeAndLength(0, value)
      : encodeTypeAndLength(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([encodeTypeAndLength(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([encodeTypeAndLength(2, value.length), value]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([
      encodeTypeAndLength(4, value.length),
      ...value.map(encodeCbor),
    ]);
  }
  return Buffer.concat([
    encodeTypeAndLength(5, value.size),
    ...[...value.entries()].flatMap(([key, entry]) => [
      encodeCbor(key),
      encodeCbor(entry),
    ]),
  ]);
}

function encodeTypeAndLength(type: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(type << 5) | length]);
  if (length <= 0xff) return Buffer.from([(type << 5) | 24, length]);
  if (length <= 0xffff) {
    const encoded = Buffer.alloc(3);
    encoded[0] = (type << 5) | 25;
    encoded.writeUInt16BE(length, 1);
    return encoded;
  }
  const encoded = Buffer.alloc(5);
  encoded[0] = (type << 5) | 26;
  encoded.writeUInt32BE(length, 1);
  return encoded;
}

function uint32LittleEndian(value: number): Buffer {
  const encoded = Buffer.alloc(4);
  encoded.writeUInt32LE(value);
  return encoded;
}

function sha256(value: Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

describe("App Attest verification errors", () => {
  it("keeps detailed cryptographic reasons out of the public message", () => {
    expect(new AppAttestVerificationError("invalid_nonce").message).toBe(
      "App Attest verification failed",
    );
  });
});

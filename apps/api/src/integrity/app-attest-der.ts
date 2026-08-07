const sequenceTag = 0x30;
const objectIdentifierTag = 0x06;
const octetStringTag = 0x04;
const booleanTag = 0x01;
const extensionsTag = 0xa3;
const nonceWrapperTag = 0xa1;

export class DerDecodingError extends Error {
  public constructor() {
    super("Invalid App Attest certificate extension");
    this.name = "DerDecodingError";
  }
}

export function extractAppAttestNonce(certificateDer: Buffer): Buffer {
  const extension = extractCertificateExtension(
    certificateDer,
    "1.2.840.113635.100.8.2",
  );
  const sequence = requireSingleElement(extension, sequenceTag);
  const wrapper = requireSingleElement(sequence.content, nonceWrapperTag);
  const nonce = requireSingleElement(wrapper.content, octetStringTag);
  if (nonce.content.length !== 32) throw new DerDecodingError();
  return nonce.content;
}

export function extractCertificateExtension(
  certificateDer: Buffer,
  expectedOid: string,
): Buffer {
  const certificate = requireSingleElement(certificateDer, sequenceTag);
  const certificateFields = readChildren(certificate.content);
  const tbsCertificate = certificateFields[0];
  if (!tbsCertificate || tbsCertificate.tag !== sequenceTag) {
    throw new DerDecodingError();
  }
  const tbsFields = readChildren(tbsCertificate.content);
  const extensions = tbsFields.find((field) => field.tag === extensionsTag);
  if (!extensions) throw new DerDecodingError();
  const extensionsSequence = requireSingleElement(
    extensions.content,
    sequenceTag,
  );
  let match: Buffer | undefined;
  for (const encodedExtension of readChildren(extensionsSequence.content)) {
    if (encodedExtension.tag !== sequenceTag) throw new DerDecodingError();
    const fields = readChildren(encodedExtension.content);
    const oidField = fields[0];
    if (!oidField || oidField.tag !== objectIdentifierTag) {
      throw new DerDecodingError();
    }
    const oid = decodeObjectIdentifier(oidField.content);
    let valueIndex = 1;
    if (fields[valueIndex]?.tag === booleanTag) valueIndex += 1;
    const value = fields[valueIndex];
    if (
      !value ||
      value.tag !== octetStringTag ||
      valueIndex !== fields.length - 1
    ) {
      throw new DerDecodingError();
    }
    if (oid !== expectedOid) continue;
    if (match) throw new DerDecodingError();
    match = value.content;
  }
  if (!match) throw new DerDecodingError();
  return match;
}

interface DerElement {
  tag: number;
  content: Buffer;
  bytesRead: number;
}

function requireSingleElement(input: Buffer, tag: number): DerElement {
  const element = readElement(input, 0);
  if (element.tag !== tag || element.bytesRead !== input.length) {
    throw new DerDecodingError();
  }
  return element;
}

function readChildren(input: Buffer): DerElement[] {
  const children: DerElement[] = [];
  let offset = 0;
  while (offset < input.length) {
    const child = readElement(input, offset);
    children.push(child);
    offset += child.bytesRead;
  }
  if (offset !== input.length) throw new DerDecodingError();
  return children;
}

function readElement(input: Buffer, offset: number): DerElement {
  const tag = input[offset];
  const firstLength = input[offset + 1];
  if (tag === undefined || firstLength === undefined) {
    throw new DerDecodingError();
  }
  // High-tag-number form is unnecessary for the certificate structures used
  // here and rejecting it keeps the parser's accepted surface unambiguous.
  if ((tag & 0x1f) === 0x1f) throw new DerDecodingError();
  let length = 0;
  let lengthBytes = 1;
  if ((firstLength & 0x80) === 0) {
    length = firstLength;
  } else {
    const count = firstLength & 0x7f;
    if (count === 0 || count > 4 || offset + 2 + count > input.length) {
      throw new DerDecodingError();
    }
    if (input[offset + 2] === 0) throw new DerDecodingError();
    lengthBytes += count;
    for (let index = 0; index < count; index += 1) {
      length = length * 256 + (input[offset + 2 + index] ?? 0);
    }
    if (length < 128) throw new DerDecodingError();
  }
  const contentStart = offset + 1 + lengthBytes;
  const contentEnd = contentStart + length;
  if (contentEnd > input.length) throw new DerDecodingError();
  return {
    tag,
    content: input.subarray(contentStart, contentEnd),
    bytesRead: contentEnd - offset,
  };
}

function decodeObjectIdentifier(input: Buffer): string {
  const first = input[0];
  if (first === undefined) throw new DerDecodingError();
  const components = [Math.min(Math.floor(first / 40), 2)];
  components.push(first - components[0]! * 40);
  let current = 0;
  let hasOpenComponent = false;
  for (let index = 1; index < input.length; index += 1) {
    const byte = input[index];
    if (byte === undefined) throw new DerDecodingError();
    if (!hasOpenComponent && byte === 0x80) throw new DerDecodingError();
    hasOpenComponent = true;
    current = current * 128 + (byte & 0x7f);
    if (!Number.isSafeInteger(current)) throw new DerDecodingError();
    if ((byte & 0x80) === 0) {
      components.push(current);
      current = 0;
      hasOpenComponent = false;
    }
  }
  if (hasOpenComponent) throw new DerDecodingError();
  return components.join(".");
}

/**
 * AES-256-GCM and gateway ID/secret key generation.
 * Works in browser (Web Crypto) and Node (Web Crypto or node:crypto fallback).
 * Wire format: IV (12B) + ciphertext + tag (16B), compatible with openclaw-mqtt-bridge.
 */

const IV_LENGTH = 12;
const ALGORITHM = "AES-GCM";

/** Internal: key may be Web Crypto CryptoKey or Node raw key for fallback. */
type KeyLike = CryptoKey | (CryptoKey & { __nodeRaw?: Uint8Array });

function isNodeEnv(): boolean {
  return typeof process !== "undefined" && typeof process.versions === "object" && typeof process.versions.node === "string";
}

function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function getRandomValues(bytes: Uint8Array): void {
  const c = typeof globalThis !== "undefined" ? (globalThis as { crypto?: { getRandomValues: (a: Uint8Array) => Uint8Array } }).crypto : undefined;
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
    return;
  }
  if (isNodeEnv()) {
    const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
    if (g.crypto?.getRandomValues) {
      g.crypto.getRandomValues(bytes);
      return;
    }
  }
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
}

/** Import a Base64-encoded 256-bit key. Returns CryptoKey (browser) or key-like for Node fallback. */
export async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToBytes(base64Key);
  if (raw.length !== 32) {
    throw new Error("secretKey must be 32 bytes (256-bit)");
  }
  const c = typeof globalThis !== "undefined" ? (globalThis as { crypto?: { subtle?: Crypto["subtle"] } }).crypto : undefined;
  if (c?.subtle) {
    return c.subtle.importKey("raw", raw, { name: ALGORITHM }, false, ["encrypt", "decrypt"]) as Promise<CryptoKey>;
  }
  if (isNodeEnv()) {
    const wrapper = {} as CryptoKey & { __nodeRaw?: Uint8Array };
    (wrapper as { __nodeRaw: Uint8Array }).__nodeRaw = raw;
    return wrapper as CryptoKey;
  }
  throw new Error("No crypto implementation available");
}

async function getNodeCrypto(): Promise<typeof import("node:crypto")> {
  return import("node:crypto");
}

function hasNodeRaw(key: KeyLike): key is CryptoKey & { __nodeRaw: Uint8Array } {
  return typeof (key as { __nodeRaw?: Uint8Array }).__nodeRaw !== "undefined";
}

/** Encrypt plaintext; returns IV (12B) + ciphertext + tag (16B). */
export async function encrypt(plaintext: string, key: KeyLike): Promise<ArrayBuffer> {
  if (hasNodeRaw(key)) {
    const nodeCrypto = await getNodeCrypto();
    const iv = nodeCrypto.randomBytes(IV_LENGTH);
    const cipher = nodeCrypto.createCipheriv("aes-256-gcm", Buffer.from(key.__nodeRaw), iv, { authTagLength: 16 });
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, enc, tag]).buffer.slice(
      Buffer.concat([iv, enc, tag]).byteOffset,
      Buffer.concat([iv, enc, tag]).byteOffset + Buffer.concat([iv, enc, tag]).byteLength,
    );
  }
  const iv = new Uint8Array(IV_LENGTH);
  getRandomValues(iv);
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertextWithTag = await (globalThis as { crypto: Crypto }).crypto.subtle.encrypt(
    { name: ALGORITHM, iv, tagLength: 128 },
    key as CryptoKey,
    encoded,
  );
  const result = new Uint8Array(IV_LENGTH + ciphertextWithTag.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertextWithTag), IV_LENGTH);
  return result.buffer;
}

/** Decrypt payload (IV + ciphertext + tag); returns plaintext or null. */
export async function decrypt(data: ArrayBuffer, key: KeyLike): Promise<string | null> {
  const bytes = new Uint8Array(data);
  if (bytes.length < 28) {
    return null;
  }
  if (hasNodeRaw(key)) {
    try {
      const nodeCrypto = await getNodeCrypto();
      const iv = bytes.subarray(0, IV_LENGTH);
      const tag = bytes.subarray(bytes.length - 16);
      const ciphertext = bytes.subarray(IV_LENGTH, bytes.length - 16);
      const decipher = nodeCrypto.createDecipheriv(
        "aes-256-gcm",
        Buffer.from(key.__nodeRaw),
        Buffer.from(iv),
        { authTagLength: 16 },
      );
      decipher.setAuthTag(Buffer.from(tag));
      return decipher.update(Buffer.from(ciphertext)) + decipher.final("utf8");
    } catch {
      return null;
    }
  }
  try {
    const iv = bytes.slice(0, IV_LENGTH);
    const ciphertextWithTag = bytes.slice(IV_LENGTH);
    const decrypted = await (globalThis as { crypto: Crypto }).crypto.subtle.decrypt(
      { name: ALGORITHM, iv, tagLength: 128 },
      key as CryptoKey,
      ciphertextWithTag,
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}

/** Generate a 256-bit random secret key, Base64-encoded. */
export function generateSecretKey(): string {
  const bytes = new Uint8Array(32);
  getRandomValues(bytes);
  return bytesToBase64(bytes);
}

/** Generate a gateway ID (nanoid-style: gw- + 21 chars). */
export function generateGatewayId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = new Uint8Array(21);
  getRandomValues(bytes);
  let id = "gw-";
  for (let i = 0; i < bytes.length; i++) {
    id += alphabet[bytes[i]! % alphabet.length];
  }
  return id;
}

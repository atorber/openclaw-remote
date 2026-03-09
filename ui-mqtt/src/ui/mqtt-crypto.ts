/**
 * AES-256-GCM encrypt/decrypt using the Web Crypto API (browser-side).
 * Wire format: IV (12 bytes) + ciphertext + authTag (16 bytes).
 * Compatible with the Node.js `node:crypto` implementation in the bridge.
 */

const IV_LENGTH = 12;
const ALGORITHM = "AES-GCM";

/** Import a Base64-encoded 256-bit key into a CryptoKey for AES-GCM. */
export async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToBuffer(base64Key);
  return crypto.subtle.importKey("raw", raw, { name: ALGORITHM }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns an ArrayBuffer of [IV (12B) | ciphertext + tag].
 * Note: Web Crypto appends the 16-byte GCM tag to the ciphertext automatically.
 */
export async function encrypt(plaintext: string, key: CryptoKey): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertextWithTag = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv, tagLength: 128 },
    key,
    encoded,
  );
  // Concatenate: IV + (ciphertext + tag)
  const result = new Uint8Array(IV_LENGTH + ciphertextWithTag.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertextWithTag), IV_LENGTH);
  return result.buffer;
}

/**
 * Decrypt a binary payload (IV + ciphertext + tag) using AES-256-GCM.
 * Returns the plaintext string, or null on failure (wrong key, tampered data).
 */
export async function decrypt(data: ArrayBuffer, key: CryptoKey): Promise<string | null> {
  const bytes = new Uint8Array(data);
  // Minimum: 12 (IV) + 16 (tag) = 28 bytes
  if (bytes.length < 28) {
    return null;
  }
  try {
    const iv = bytes.slice(0, IV_LENGTH);
    // Web Crypto expects ciphertext + tag together (tag is at the end)
    const ciphertextWithTag = bytes.slice(IV_LENGTH);
    const decrypted = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv, tagLength: 128 },
      key,
      ciphertextWithTag,
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}

/** Generate a 256-bit (32-byte) random secret key, returned as Base64. */
export function generateSecretKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bufferToBase64(bytes);
}

/** Generate a random gateway ID (nanoid-style, 21 chars). */
export function generateGatewayId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(21));
  let id = "gw-";
  for (const b of bytes) {
    id += alphabet[b % alphabet.length];
  }
  return id;
}

function base64ToBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bufferToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

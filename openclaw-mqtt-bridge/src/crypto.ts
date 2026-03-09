import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ALGORITHM = "aes-256-gcm";

/**
 * Encrypt a plaintext JSON string using AES-256-GCM.
 * Returns: Buffer of [IV (12B) | ciphertext | authTag (16B)].
 */
export function encrypt(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Wire format: IV + ciphertext + tag
  return Buffer.concat([iv, encrypted, tag]);
}

/**
 * Decrypt a binary payload (IV + ciphertext + tag) using AES-256-GCM.
 * Returns the plaintext string, or null on any failure (bad key, tampered, etc).
 */
export function decrypt(data: Buffer, key: Buffer): string | null {
  if (data.length < IV_LENGTH + TAG_LENGTH) {
    return null;
  }
  try {
    const iv = data.subarray(0, IV_LENGTH);
    const tag = data.subarray(data.length - TAG_LENGTH);
    const ciphertext = data.subarray(IV_LENGTH, data.length - TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

/** Parse a Base64-encoded secret key string into a 32-byte Buffer. */
export function parseSecretKey(base64Key: string): Buffer {
  return Buffer.from(base64Key, "base64");
}

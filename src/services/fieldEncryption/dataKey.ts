import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { inspect } from "node:util";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * An unwrapped AES-256 key. The bytes sit in a private field, and every way
 * of printing the object prints a placeholder, so logging it by mistake
 * leaks nothing.
 */
export class DataKey {
  readonly #bytes: Buffer;

  constructor(bytes: Uint8Array) {
    if (bytes.length !== KEY_BYTES) throw new Error("A data key is 32 bytes");
    this.#bytes = Buffer.from(bytes);
  }

  static generate(): DataKey {
    return new DataKey(randomBytes(KEY_BYTES));
  }

  /** The raw bytes, only for wrapping the key. */
  exportBytes(): Buffer {
    return Buffer.from(this.#bytes);
  }

  seal(plaintext: Buffer, aad: Buffer): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#bytes, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]);
  }

  open(sealed: Buffer, aad: Buffer): Buffer {
    if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error("Ciphertext is too short");
    const iv = sealed.subarray(0, IV_BYTES);
    const tag = sealed.subarray(sealed.length - TAG_BYTES);
    const body = sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, this.#bytes, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  }

  toString(): string {
    return "[DataKey]";
  }

  toJSON(): string {
    return "[DataKey]";
  }

  [inspect.custom](): string {
    return "[DataKey]";
  }
}

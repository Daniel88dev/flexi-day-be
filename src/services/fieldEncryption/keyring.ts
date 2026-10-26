import { createHash } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { config } from "../../config.js";
import { dataKeyWrapping } from "../../db/schema/organization-data-key-schema.js";
import { DataKey } from "./dataKey.js";

export const DATA_KEY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type WrappedDataKey = {
  wrapping: dataKeyWrapping;
  wrappedKey: string;
  version: number;
};

type KeyWrapper = {
  kind: dataKeyWrapping;
  generate(organizationId: string): Promise<{ key: DataKey; wrappedKey: string }>;
  unwrap(organizationId: string, wrappedKey: string): Promise<DataKey>;
};

// Never rotates and keys nothing outside dev and test, so it can sit in source.
const LOCAL_WRAPPING_KEY = new DataKey(
  createHash("sha256").update("flexi-day local field encryption, never production").digest()
);

const localAad = (organizationId: string) => Buffer.from(`flexi-day/data-key|${organizationId}`);

const localWrapper: KeyWrapper = {
  kind: dataKeyWrapping.Local,
  generate(organizationId) {
    const key = DataKey.generate();
    const bytes = key.exportBytes();
    const sealed = LOCAL_WRAPPING_KEY.seal(bytes, localAad(organizationId));
    bytes.fill(0);
    return Promise.resolve({ key, wrappedKey: sealed.toString("base64") });
  },
  unwrap(organizationId, wrappedKey) {
    const bytes = LOCAL_WRAPPING_KEY.open(
      Buffer.from(wrappedKey, "base64"),
      localAad(organizationId)
    );
    const key = new DataKey(bytes);
    bytes.fill(0);
    return Promise.resolve(key);
  },
};

let kmsClient: KMSClient | undefined;

const kmsWrapper = (keyArn: string): KeyWrapper => {
  const kms = () => (kmsClient ??= new KMSClient({ region: config.organizationData.region }));
  const takeKey = (plaintext: Uint8Array | undefined): DataKey => {
    if (!plaintext) throw new Error("KMS returned no plaintext data key");
    const key = new DataKey(plaintext);
    plaintext.fill(0);
    return key;
  };
  return {
    kind: dataKeyWrapping.Kms,
    async generate(organizationId) {
      const out = await kms().send(
        new GenerateDataKeyCommand({
          KeyId: keyArn,
          KeySpec: "AES_256",
          EncryptionContext: { organizationId },
        })
      );
      if (!out.CiphertextBlob) throw new Error("KMS returned no wrapped data key");
      return {
        key: takeKey(out.Plaintext),
        wrappedKey: Buffer.from(out.CiphertextBlob).toString("base64"),
      };
    },
    async unwrap(organizationId, wrappedKey) {
      const out = await kms().send(
        new DecryptCommand({
          KeyId: keyArn,
          CiphertextBlob: Buffer.from(wrappedKey, "base64"),
          EncryptionContext: { organizationId },
        })
      );
      return takeKey(out.Plaintext);
    },
  };
};

/** Production wraps with KMS; dev and test with the static local key, never KMS. */
export const dataKeyWrapper = (): KeyWrapper => {
  if (config.api.env !== "production") return localWrapper;
  const keyArn = config.organizationData.kmsKeyArn;
  if (!keyArn) {
    throw new Error("Field encryption needs ORGANIZATION_DATA_KMS_KEY_ARN in production");
  }
  return kmsWrapper(keyArn);
};

type CachedKey = { wrappedKey: string; version: number; key: DataKey; expiresAt: number };

const cache = new Map<string, CachedKey>();

export const rememberDataKey = (organizationId: string, stored: WrappedDataKey, key: DataKey) => {
  cache.set(organizationId, {
    wrappedKey: stored.wrappedKey,
    version: stored.version,
    key,
    expiresAt: Date.now() + DATA_KEY_CACHE_TTL_MS,
  });
};

/** Drops every unwrapped key this process holds. */
export const forgetDataKeys = () => cache.clear();

/**
 * Unwraps the organization's stored key, at most once a day per instance. A
 * cached key counts only while the stored row still matches it, so a re-key
 * on another instance or in the script is picked up on the next read.
 */
export const unwrapDataKey = async (
  organizationId: string,
  stored: WrappedDataKey
): Promise<DataKey> => {
  const hit = cache.get(organizationId);
  if (
    hit &&
    hit.expiresAt > Date.now() &&
    hit.version === stored.version &&
    hit.wrappedKey === stored.wrappedKey
  ) {
    return hit.key;
  }
  cache.delete(organizationId);

  const wrapper = dataKeyWrapper();
  if (stored.wrapping !== wrapper.kind) {
    throw new Error(
      `The data key of organization ${organizationId} is wrapped by ${stored.wrapping}, ` +
        `but this environment wraps with ${wrapper.kind}`
    );
  }
  const key = await wrapper.unwrap(organizationId, stored.wrappedKey);
  rememberDataKey(organizationId, stored, key);
  return key;
};

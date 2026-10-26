import { eq } from "drizzle-orm";
import type { DbTransaction } from "../../db/db.js";
import { organizationDataKeys } from "../../db/schema/organization-data-key-schema.js";
import type { DataKey } from "./dataKey.js";
import { dataKeyWrapper, rememberDataKey, unwrapDataKey, type WrappedDataKey } from "./keyring.js";

const FORMAT = "fe1";

export type OrganizationCipher = {
  /** The data key version new values are written under. */
  version: number;
  encrypt(value: string, context: string): string;
  decrypt(stored: string, context: string): string;
};

/**
 * Names the field a value belongs to. It is bound into the ciphertext, so a
 * value copied to another row, column or organization fails to decrypt.
 */
export const fieldContext = (table: string, column: string, rowId: string): string =>
  `${table}.${column}:${rowId}`;

const aad = (organizationId: string, context: string) =>
  Buffer.from(`flexi-day/field/${FORMAT}|${organizationId}|${context}`);

export const sealField = (
  key: DataKey,
  version: number,
  organizationId: string,
  value: string,
  context: string
): string => {
  const sealed = key.seal(Buffer.from(value, "utf8"), aad(organizationId, context));
  return `${FORMAT}:${version}:${sealed.toString("base64url")}`;
};

export const openField = (
  key: DataKey,
  version: number,
  organizationId: string,
  stored: string,
  context: string
): string => {
  const [format, storedVersion, body] = stored.split(":");
  if (format !== FORMAT || !body) throw new Error("Not an encrypted field value");
  if (Number(storedVersion) !== version) {
    throw new Error(
      `Field written under data key version ${storedVersion}, the organization is on ${version}`
    );
  }
  return key.open(Buffer.from(body, "base64url"), aad(organizationId, context)).toString("utf8");
};

const cipherFor = (organizationId: string, version: number, key: DataKey): OrganizationCipher => ({
  version,
  encrypt: (value, context) => sealField(key, version, organizationId, value, context),
  decrypt: (stored, context) => openField(key, version, organizationId, stored, context),
});

const readStoredKey = async (
  organizationId: string,
  tx: DbTransaction
): Promise<WrappedDataKey | undefined> => {
  const [row] = await tx
    .select({
      wrapping: organizationDataKeys.wrapping,
      wrappedKey: organizationDataKeys.wrappedKey,
      version: organizationDataKeys.version,
    })
    .from(organizationDataKeys)
    .where(eq(organizationDataKeys.organizationId, organizationId))
    .for("share");
  return row;
};

/**
 * The organization's cipher for Sensitive section fields, creating its data
 * key on first use. The key row stays share-locked until `tx` ends, which is
 * what keeps a re-key from slipping between reading a key and writing with it.
 */
export const openOrganizationCipher = async (
  organizationId: string,
  tx: DbTransaction
): Promise<OrganizationCipher> => {
  const stored = await readStoredKey(organizationId, tx);
  if (stored) {
    return cipherFor(organizationId, stored.version, await unwrapDataKey(organizationId, stored));
  }

  const wrapper = dataKeyWrapper();
  const { key, wrappedKey } = await wrapper.generate(organizationId);
  const [created] = await tx
    .insert(organizationDataKeys)
    .values({ organizationId, wrapping: wrapper.kind, wrappedKey, version: 1 })
    .onConflictDoNothing()
    .returning({
      wrapping: organizationDataKeys.wrapping,
      wrappedKey: organizationDataKeys.wrappedKey,
      version: organizationDataKeys.version,
    });
  if (created) {
    rememberDataKey(organizationId, created, key);
    return cipherFor(organizationId, created.version, key);
  }

  // Another request created the key first; use theirs.
  const winner = await readStoredKey(organizationId, tx);
  if (!winner) throw new Error(`No data key for organization ${organizationId}`);
  return cipherFor(organizationId, winner.version, await unwrapDataKey(organizationId, winner));
};

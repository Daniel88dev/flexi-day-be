import { eq, sql } from "drizzle-orm";
import { db } from "../../db/db.js";
import { organizationDataKeys } from "../../db/schema/organization-data-key-schema.js";
import { fieldContext, openField, sealField } from "./fieldEncryptionServices.js";
import { dataKeyWrapper, rememberDataKey, unwrapDataKey } from "./keyring.js";

/** A table holding encrypted fields, each sealed with `fieldContext(table, column, id)`. */
export type EncryptedTable = {
  table: string;
  id: string;
  organizationId: string;
  columns: string[];
};

/**
 * Every table with fields under an organization's data key. The re-key walks
 * exactly these, so a table that encrypts a field and is missing here is left
 * unreadable by the first re-key.
 */
export const ENCRYPTED_TABLES: EncryptedTable[] = [
  {
    table: "directory_sensitive_profiles",
    id: "employment_id",
    organizationId: "organization_id",
    columns: ["contact", "personal"],
  },
];

export type RekeyResult = {
  organizationId: string;
  /** The new data key version, or null when the organization has no key yet. */
  version: number | null;
  /** Encrypted values re-written. */
  values: number;
};

/**
 * Issues a new data key for one organization and re-encrypts its rows, all in
 * one transaction. Locking the key row waits out every transaction holding
 * the old key and holds new ones off until the commit.
 */
export const rekeyOrganization = async (
  organizationId: string,
  { tables = ENCRYPTED_TABLES }: { tables?: EncryptedTable[] } = {}
): Promise<RekeyResult> => {
  const result = await db.transaction(async (tx) => {
    const [stored] = await tx
      .select({
        wrapping: organizationDataKeys.wrapping,
        wrappedKey: organizationDataKeys.wrappedKey,
        version: organizationDataKeys.version,
      })
      .from(organizationDataKeys)
      .where(eq(organizationDataKeys.organizationId, organizationId))
      .for("update");
    if (!stored) return { organizationId, version: null, values: 0, next: undefined };

    const oldKey = await unwrapDataKey(organizationId, stored);
    const wrapper = dataKeyWrapper();
    const { key: newKey, wrappedKey } = await wrapper.generate(organizationId);
    const version = stored.version + 1;
    let values = 0;

    for (const spec of tables) {
      const columns = sql.join(
        spec.columns.map((column) => sql.identifier(column)),
        sql`, `
      );
      const { rows } = await tx.execute<Record<string, string | null>>(sql`
        SELECT ${sql.identifier(spec.id)} AS "__id", ${columns}
        FROM ${sql.identifier(spec.table)}
        WHERE ${sql.identifier(spec.organizationId)} = ${organizationId}
        FOR UPDATE`);

      for (const row of rows) {
        const id = String(row.__id);
        const assignments = [];
        for (const column of spec.columns) {
          const current = new Map(Object.entries(row)).get(column);
          if (current == null) continue;
          const context = fieldContext(spec.table, column, id);
          const plain = openField(oldKey, stored.version, organizationId, current, context);
          const sealed = sealField(newKey, version, organizationId, plain, context);
          assignments.push(sql`${sql.identifier(column)} = ${sealed}`);
          values += 1;
        }
        if (assignments.length === 0) continue;
        await tx.execute(sql`
          UPDATE ${sql.identifier(spec.table)} SET ${sql.join(assignments, sql`, `)}
          WHERE ${sql.identifier(spec.id)} = ${id}`);
      }
    }

    await tx
      .update(organizationDataKeys)
      .set({ version, wrapping: wrapper.kind, wrappedKey, rotatedAt: new Date() })
      .where(eq(organizationDataKeys.organizationId, organizationId));

    return {
      organizationId,
      version,
      values,
      next: { stored: { wrapping: wrapper.kind, wrappedKey, version }, key: newKey },
    };
  });

  if (result.next) rememberDataKey(organizationId, result.next.stored, result.next.key);
  return { organizationId: result.organizationId, version: result.version, values: result.values };
};

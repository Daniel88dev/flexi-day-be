import { and, asc, gt, isNotNull, notLike, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { symmetricDecrypt, symmetricEncrypt, type SecretConfig } from "better-auth/crypto";
import { db } from "../../db/db.js";
import { account, jwks, twoFactor } from "../../db/schema/auth-schema.js";
import { calendarConnection } from "../../db/schema/calendar-connection-schema.js";

const BATCH = 200;

type EncryptedColumn = {
  name: string;
  table: PgTable;
  id: PgColumn;
  column: PgColumn;
  /** better-auth stored these as plaintext before `encryptOAuthTokens`, and still reads them. */
  mayBePlaintext?: boolean;
  /** `jwt()` stores its ciphertext as a JSON string, quotes included. */
  jsonWrapped?: boolean;
};

const ENCRYPTED_COLUMNS: EncryptedColumn[] = [
  { name: "two_factor.secret", table: twoFactor, id: twoFactor.id, column: twoFactor.secret },
  {
    name: "two_factor.backup_codes",
    table: twoFactor,
    id: twoFactor.id,
    column: twoFactor.backupCodes,
  },
  {
    name: "account.access_token",
    table: account,
    id: account.id,
    column: account.accessToken,
    mayBePlaintext: true,
  },
  {
    name: "account.refresh_token",
    table: account,
    id: account.id,
    column: account.refreshToken,
    mayBePlaintext: true,
  },
  {
    name: "calendar_connection.refresh_token_enc",
    table: calendarConnection,
    id: calendarConnection.id,
    column: calendarConnection.refreshTokenEnc,
  },
  {
    name: "calendar_connection.access_token_enc",
    table: calendarConnection,
    id: calendarConnection.id,
    column: calendarConnection.accessTokenEnc,
  },
  // The key that signs AI connections' access tokens. Left behind, the second
  // rotation makes it unreadable and no app gets a token.
  {
    name: "jwks.private_key",
    table: jwks,
    id: jwks.id,
    column: jwks.privateKey,
    jsonWrapped: true,
  },
];

const unwrap = (target: EncryptedColumn, stored: string): string | null => {
  if (!target.jsonWrapped) return stored;
  try {
    const value: unknown = JSON.parse(stored);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
};

// The same test better-auth's `decryptOAuthToken` applies before decrypting.
const looksEncrypted = (value: string): boolean =>
  value.startsWith("$ba$") || (value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value));

export type ReencryptResult = {
  /** Rows now under the current version. */
  reencrypted: number;
  /** Ids of rows no key in the config opens, by column. They are left as they are. */
  unreadable: Record<string, string[]>;
};

/**
 * Moves every value encrypted under an older secret version, or under the
 * pre-versioning key, onto the current version. Only two versions are kept,
 * so a row nobody touches between two rotations would otherwise outlive its
 * key: a dormant user's TOTP secret is the case that locks someone out.
 *
 * Each write is conditional on the value it read, so a concurrent writer, or
 * another instance running the same sweep, wins rather than being overwritten.
 */
export const reencryptToCurrentVersion = async (key: SecretConfig): Promise<ReencryptResult> => {
  const currentPrefix = `$ba$${key.currentVersion}$%`;
  const result: ReencryptResult = { reencrypted: 0, unreadable: {} };

  for (const target of ENCRYPTED_COLUMNS) {
    let after = "";
    for (;;) {
      const rows = (await db
        .select({ id: target.id, stored: target.column })
        .from(target.table)
        .where(
          and(
            gt(target.id, after),
            isNotNull(target.column),
            notLike(target.column, target.jsonWrapped ? `"${currentPrefix}` : currentPrefix)
          )
        )
        .orderBy(asc(target.id))
        .limit(BATCH)) as { id: string; stored: string }[];
      const last = rows.at(-1);
      if (!last) break;
      after = last.id;

      for (const { id, stored } of rows) {
        if (!stored || (target.mayBePlaintext && !looksEncrypted(stored))) continue;

        const ciphertext = unwrap(target, stored);
        let plain: string;
        try {
          if (ciphertext === null) throw new Error("Not a wrapped ciphertext");
          plain = await symmetricDecrypt({ key, data: ciphertext });
        } catch {
          (result.unreadable[target.name] ??= []).push(id);
          continue;
        }

        const encrypted = await symmetricEncrypt({ key, data: plain });
        const next = target.jsonWrapped ? JSON.stringify(encrypted) : encrypted;
        const updated = await db.execute(
          sql`update ${target.table} set ${sql.identifier(target.column.name)} = ${next}
              where ${target.id} = ${id} and ${target.column} = ${stored}`
        );
        result.reencrypted += updated.rowCount ?? 0;
      }
    }
  }
  return result;
};

import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../db/db.js";
import { session } from "../../db/schema/auth-schema.js";
import { authSecretFingerprint as fingerprintTable } from "../../db/schema/auth-secret-schema.js";

const FINGERPRINT_LABEL = "flexi-day:auth-secret-fingerprint:v1";

/** Keyed by the secret, so the stored value says nothing about it. */
export const authSecretFingerprint = (secret: string): string =>
  createHmac("sha256", secret).update(FINGERPRINT_LABEL).digest("hex");

export type AuthSecretCheck =
  | { outcome: "recorded"; sessionsDeleted: 0 }
  | { outcome: "unchanged"; sessionsDeleted: 0 }
  | { outcome: "rotated"; sessionsDeleted: number };

/**
 * A rotated secret voids every session cookie, but the rows would stay, and
 * with them each phone's push registration. So a changed fingerprint deletes
 * every session row; registrations cascade. The table lock makes instances
 * that boot together agree on one deletion.
 */
export const checkAuthSecret = async (secret: string): Promise<AuthSecretCheck> => {
  const fingerprint = authSecretFingerprint(secret);

  return db.transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE ${fingerprintTable} IN EXCLUSIVE MODE`);
    const [stored] = await tx.select().from(fingerprintTable);

    if (stored?.fingerprint === fingerprint) return { outcome: "unchanged", sessionsDeleted: 0 };

    await tx.delete(fingerprintTable);
    await tx.insert(fingerprintTable).values({ fingerprint });
    if (!stored) return { outcome: "recorded", sessionsDeleted: 0 };

    const deleted = await tx.delete(session);
    return { outcome: "rotated", sessionsDeleted: deleted.rowCount ?? 0 };
  });
};

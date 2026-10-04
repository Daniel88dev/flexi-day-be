import { and, eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { account } from "../../db/schema/auth-schema.js";
import type { AppleLink, StoredAppleTokens } from "./types.js";

export const findAppleAccounts = (userId: string): Promise<AppleLink[]> =>
  db
    .select({ id: account.id, accountId: account.accountId })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "apple")));

export const saveAppleTokens = async (rowId: string, tokens: StoredAppleTokens): Promise<void> => {
  await db.update(account).set(tokens).where(eq(account.id, rowId));
};

import { and, eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { account } from "../../db/schema/auth-schema.js";
import type { AppleLink, StoredAppleLink, StoredAppleTokens } from "./types.js";

const appleLinksOf = (userId: string) =>
  and(eq(account.userId, userId), eq(account.providerId, "apple"));

export const findAppleAccounts = (userId: string): Promise<AppleLink[]> =>
  db
    .select({ id: account.id, accountId: account.accountId })
    .from(account)
    .where(appleLinksOf(userId));

export const findAppleLinksToRevoke = (userId: string): Promise<StoredAppleLink[]> =>
  db
    .select({
      id: account.id,
      userId: account.userId,
      refreshToken: account.refreshToken,
      idToken: account.idToken,
    })
    .from(account)
    .where(appleLinksOf(userId));

export const saveAppleTokens = async (rowId: string, tokens: StoredAppleTokens): Promise<void> => {
  await db.update(account).set(tokens).where(eq(account.id, rowId));
};

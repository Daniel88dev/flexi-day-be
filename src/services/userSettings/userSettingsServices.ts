import { db, type DbTransaction } from "../../db/db.js";
import { userSettings } from "../../db/schema/user-settings-schema.js";
import { eq, inArray } from "drizzle-orm";
import { DEFAULT_USER_SETTINGS, type UserSettingsPatch, type UserSettingsRecord } from "./types.js";

export const getUserSettings = async (
  userId: string,
  tx?: DbTransaction
): Promise<UserSettingsRecord | undefined> => {
  const [row] = await (tx ?? db)
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);

  return row;
};

/**
 * Stores the user's preferences, creating the row on first change. Users
 * without a row are on the defaults, so this is always an upsert. `patch` may
 * carry any subset of the settings — the screen saves one card at a time, and
 * unmentioned fields keep their stored value (or take the default on insert).
 */
export const upsertUserSettings = async (
  userId: string,
  patch: UserSettingsPatch,
  tx?: DbTransaction
): Promise<UserSettingsRecord | undefined> => {
  const [row] = await (tx ?? db)
    .insert(userSettings)
    .values({ ...DEFAULT_USER_SETTINGS, ...patch, userId })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: patch,
    })
    .returning();

  return row;
};

/**
 * Which of the supplied users still want workflow email. Users with no
 * settings row are opted in, matching `DEFAULT_USER_SETTINGS` — the notifier
 * calls this before every send.
 */
export const filterUsersAcceptingEmail = async (userIds: string[]): Promise<Set<string>> => {
  const accepting = new Set(userIds);
  if (userIds.length === 0) return accepting;

  const rows = await db
    .select({
      userId: userSettings.userId,
      emailNotifications: userSettings.emailNotifications,
    })
    .from(userSettings)
    .where(inArray(userSettings.userId, userIds));

  for (const row of rows) {
    if (!row.emailNotifications) accepting.delete(row.userId);
  }

  return accepting;
};

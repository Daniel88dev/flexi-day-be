import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/db.js";
import { userSettings } from "../../db/schema/user-settings-schema.js";
import { DEFAULT_USER_SETTINGS } from "../userSettings/types.js";

const BANNER_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The window the Privacy banner runs in: from `PRIVACY_BANNER_FROM` for 30 days, and only while
 * AI connections is switched on for everyone. The preview list doesn't count: the banner
 * announces the published texts, which go out on Day 0 with the switch.
 */
const activeBannerStart = (now: Date): Date | null => {
  const from = config.privacyBanner.from;
  if (!config.aiFeatures.aiConnectionsEnabled || !from) return null;
  const elapsed = now.getTime() - from.getTime();
  return elapsed >= 0 && elapsed < BANNER_DAYS * DAY_MS ? from : null;
};

export const privacyBannerShows = async (userId: string, now = new Date()): Promise<boolean> => {
  const from = activeBannerStart(now);
  if (!from) return false;
  const [row] = await db
    .select({ dismissedAt: userSettings.privacyBannerDismissedAt })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  const dismissedAt = row?.dismissedAt;
  return !dismissedAt || dismissedAt.getTime() < from.getTime();
};

/** Records the dismissal at `now`; a later start date shows the banner again. */
export const dismissPrivacyBanner = async (userId: string, now = new Date()): Promise<void> => {
  await db
    .insert(userSettings)
    .values({ ...DEFAULT_USER_SETTINGS, userId, privacyBannerDismissedAt: now })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { privacyBannerDismissedAt: now },
    });
};

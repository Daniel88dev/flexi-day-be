import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { notifications, notificationType } from "../../db/schema/notification-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { appLanguage, userSettings } from "../../db/schema/user-settings-schema.js";
import { logger } from "../../middleware/logger.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { pushNotifications } from "../push/pushServices.js";

export type DirectoryEnabledNotice = { userId: string; title: string; body: string; href: string };

const COPY = {
  [appLanguage.English]: {
    title: (organization: string) => `${organization} turned on the people directory`,
    body: "Check your profile and add your contact details.",
  },
  [appLanguage.Czech]: {
    title: (organization: string) => `Organizace ${organization} zapnula adresář lidí`,
    body: "Zkontrolujte svůj profil a doplňte své kontaktní údaje.",
  },
};

const ownProfileHref = (organizationId: string, employmentId: string) =>
  `/directory/person/?organizationId=${encodeURIComponent(organizationId)}&employmentId=${encodeURIComponent(employmentId)}`;

/**
 * The members' notice for a directory just turned on: one per bound open
 * Employment, each in its reader's language and linked to their own profile.
 * The owner who turned it on and Deleted accounts get none. Runs inside the
 * enable's transaction, so it sees what the enable committed.
 */
export const planDirectoryEnabledNotices = async (
  organizationId: string,
  actorUserId: string,
  tx: DbTransaction
): Promise<DirectoryEnabledNotice[]> => {
  const rows = await tx
    .select({
      userId: employments.userId,
      employmentId: employments.id,
      organizationName: organizations.name,
      language: userSettings.language,
    })
    .from(employments)
    .innerJoin(organizations, eq(organizations.id, employments.organizationId))
    .innerJoin(user, eq(user.id, employments.userId))
    .leftJoin(userSettings, eq(userSettings.userId, employments.userId))
    .where(
      and(
        eq(employments.organizationId, organizationId),
        isNull(employments.endedAt),
        isNotNull(employments.userId),
        isNull(employments.accountDeletedAt),
        isNull(user.deletedAt),
        ne(employments.userId, actorUserId)
      )
    );

  return rows.map((row) => {
    const copy = COPY[row.language ?? appLanguage.English];
    return {
      userId: row.userId!,
      title: copy.title(row.organizationName),
      body: copy.body,
      href: ownProfileHref(organizationId, row.employmentId),
    };
  });
};

/** In-app and pushed passively, never mailed. Runs after the commit and never throws. */
export const sendDirectoryEnabledNotices = async (
  organizationId: string,
  notices: DirectoryEnabledNotice[]
): Promise<void> => {
  if (notices.length === 0) return;
  try {
    const created = await db
      .insert(notifications)
      .values(
        notices.map((notice) => ({
          id: generateRandomUUID(),
          type: notificationType.DirectoryEnabled,
          ...notice,
        }))
      )
      .returning();
    await pushNotifications(created, { passive: true });
  } catch (error) {
    logger.error("Could not send the directory enabled notices", { organizationId, err: error });
  }
};

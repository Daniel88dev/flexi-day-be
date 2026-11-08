import { and, eq, isNull, ne } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { notifications, notificationType } from "../../db/schema/notification-schema.js";
import { appLanguage, userSettings } from "../../db/schema/user-settings-schema.js";
import { logger } from "../../middleware/logger.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { boundEmployment } from "../employment/boundEmployment.js";
import { pushNotifications } from "../push/pushServices.js";

export type NoticeText = { title: string; body: string };

/** T-695's member notice, as amended by its "keep `global` inference" correction. */
export const assistantMemberNotice = (organization: string): Record<appLanguage, NoticeText> => ({
  [appLanguage.English]: {
    title: `${organization} turned on the Assistant.`,
    body: "Ask it about your time off, attendance and colleagues. It's an AI run by Anthropic, which keeps chats in the US and may process them elsewhere. It sees your messages and what you can see in Flexi Day. Chats are kept 180 days, and you can delete them. Owners and admins see how much you use it and how many messages were refused, never what you wrote.",
  },
  [appLanguage.Czech]: {
    title: `V organizaci ${organization} je zapnutý Asistent.`,
    body: "Ptej se ho na svou dovolenou, docházku a kolegy. Běží u společnosti Anthropic, která chaty ukládá v USA a zpracovávat je může i jinde. Vidí tvoje zprávy a to, co vidíš ve Flexi Day. Chaty se uchovávají 180 dní a můžeš je smazat. Vlastník a správci vidí, kolik Asistenta používáš a kolik tvých zpráv bylo odmítnuto, nikdy ne to, co píšeš.",
  },
});

export type AssistantNotice = NoticeText & { userId: string };

/**
 * One notice per bound open Employment of the organization, in its reader's
 * language, except the owner who turned it on. Deleted accounts and leavers
 * get none. Runs inside the turn-on's transaction.
 */
export const planAssistantNotices = async (
  input: { organizationId: string; organizationName: string; actorUserId: string },
  tx: DbTransaction
): Promise<AssistantNotice[]> => {
  const rows = await tx
    .selectDistinct({ userId: employments.userId, language: userSettings.language })
    .from(employments)
    .innerJoin(user, eq(user.id, employments.userId))
    .leftJoin(userSettings, eq(userSettings.userId, employments.userId))
    .where(
      and(
        eq(employments.organizationId, input.organizationId),
        boundEmployment(),
        isNull(user.deletedAt),
        ne(user.id, input.actorUserId)
      )
    );
  const copy = assistantMemberNotice(input.organizationName);
  return rows.map((row) => ({
    userId: row.userId!,
    ...copy[row.language ?? appLanguage.English],
  }));
};

/** In-app and pushed passively, never mailed. Runs after the commit and never throws. */
export const sendAssistantNotices = async (
  organizationId: string,
  notices: AssistantNotice[]
): Promise<void> => {
  if (notices.length === 0) return;
  try {
    const created = await db
      .insert(notifications)
      .values(
        notices.map((notice) => ({
          id: generateRandomUUID(),
          type: notificationType.AssistantEnabled,
          ...notice,
          href: null,
        }))
      )
      .returning();
    await pushNotifications(created, { passive: true });
  } catch (error) {
    logger.error("Could not send the Assistant notices", { organizationId, err: error });
  }
};

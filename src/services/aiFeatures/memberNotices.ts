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
type NoticeCopy = Record<appLanguage, NoticeText>;

/** T-695's member notice, as amended by its "keep `global` inference" correction. */
export const assistantMemberNotice = (organization: string): NoticeCopy => ({
  [appLanguage.English]: {
    title: `${organization} turned on the Assistant.`,
    body: "Ask it about your time off, attendance and colleagues. It's an AI run by Anthropic, which keeps chats in the US and may process them elsewhere. It sees your messages and what you can see in Flexi Day. Chats are kept 180 days, and you can delete them. Owners and admins see how much you use it and how many messages were refused, never what you wrote.",
  },
  [appLanguage.Czech]: {
    title: `V organizaci ${organization} je zapnutý Asistent.`,
    body: "Ptej se ho na svou dovolenou, docházku a kolegy. Běží u společnosti Anthropic, která chaty ukládá v USA a zpracovávat je může i jinde. Vidí tvoje zprávy a to, co vidíš ve Flexi Day. Chaty se uchovávají 180 dní a můžeš je smazat. Vlastník a správci vidí, kolik Asistenta používáš a kolik tvých zpráv bylo odmítnuto, nikdy ne to, co píšeš.",
  },
});

/** T-695's AI connections member notice. */
export const aiConnectionsMemberNotice = (organization: string): NoticeCopy => ({
  [appLanguage.English]: {
    title: `${organization} allows AI connections.`,
    body: "You can connect an AI app you use, such as Claude or ChatGPT, in Settings. What it reads goes to that app's company under your own agreement with them.",
  },
  [appLanguage.Czech]: {
    title: `V organizaci ${organization} jsou povolená AI připojení.`,
    body: "V Nastavení si můžeš připojit AI aplikaci, kterou používáš, třeba Claude nebo ChatGPT. Co přečte, jde ke společnosti, která za ní stojí, podle tvé vlastní smlouvy s ní.",
  },
});

export type MemberNotice = NoticeText & { userId: string };

/**
 * One notice per bound open Employment of the organization, in its reader's
 * language, except the owner who turned the feature on. Deleted accounts and
 * leavers get none. Runs inside the turn-on's transaction.
 */
export const planMemberNotices = async (
  input: { organizationId: string; actorUserId: string; copy: NoticeCopy },
  tx: DbTransaction
): Promise<MemberNotice[]> => {
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
  return rows.map((row) => ({
    userId: row.userId!,
    ...input.copy[row.language ?? appLanguage.English],
  }));
};

const NOTICE_HREF: Partial<Record<notificationType, string>> = {
  [notificationType.AiConnectionsEnabled]: "/settings/",
};

/** In-app and pushed passively, never mailed. Runs after the commit and never throws. */
export const sendMemberNotices = async (
  type: notificationType.AssistantEnabled | notificationType.AiConnectionsEnabled,
  organizationId: string,
  notices: MemberNotice[]
): Promise<void> => {
  if (notices.length === 0) return;
  try {
    const created = await db
      .insert(notifications)
      .values(
        notices.map((notice) => ({
          id: generateRandomUUID(),
          type,
          ...notice,
          href: NOTICE_HREF[type] ?? null,
        }))
      )
      .returning();
    await pushNotifications(created, { passive: true });
  } catch (error) {
    logger.error("Could not send the AI feature notices", { organizationId, type, err: error });
  }
};

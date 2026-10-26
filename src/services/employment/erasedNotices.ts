import { and, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import type { DbTransaction } from "../../db/db.js";
import { notifications, notificationType } from "../../db/schema/notification-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { readLog, readLogAudience } from "../../db/schema/read-log-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { accountDeletedTitles } from "../accountDeletion/accountDeletedNotice.js";
import { personExportNoticeOpening } from "../personExport/personExportNotifier.js";

const hrefParam = (param: string): SQL<string | null> =>
  sql<string | null>`substring(${notifications.href} from ${`[?&]${param}=([^&#]+)`})`;

const VACATION_NOTICES = [
  notificationType.ApprovalRequested,
  notificationType.ApprovalDecided,
  notificationType.Comment,
];

/**
 * Deletes other people's notices that name the erased person in the
 * organization. Notices store their text as written, so a name left in one
 * would outlive the erase. The schema keeps no subject column, so each kind is
 * matched by what it links to and how its text starts:
 *
 * - booking notices linking to a booking in the organization's groups that is
 *   the person's, or whose title opens with their name (they acted on it);
 * - `account_deleted` notices linking to one of the person's Employments, or
 *   to a group of the organization with the person's name as the title;
 * - `export_ready` notices about the person's Person export, for the readers
 *   the Read log holds.
 *
 * Runs before the bookings go, since the first rule reads them.
 */
export const removeNoticesAboutErasedPerson = async (
  input: {
    organizationId: string;
    userId: string;
    name: string;
    groupIds: string[];
    employmentIds: string[];
  },
  tx: DbTransaction
): Promise<number> => {
  const { organizationId, userId, name, groupIds, employmentIds } = input;

  const [organization] = await tx
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId));

  const aboutBookings =
    groupIds.length === 0
      ? undefined
      : and(
          inArray(notifications.type, VACATION_NOTICES),
          sql`exists (select 1 from ${vacation}
            where ${vacation.id} = ${hrefParam("vacationId")}
              and ${inArray(vacation.groupId, groupIds)}
              and (${vacation.userId} = ${userId}
                or starts_with(${notifications.title}, ${`${name} `})))`
        );

  const aboutDeletion = and(
    eq(notifications.type, notificationType.AccountDeleted),
    or(
      employmentIds.length === 0 ? undefined : inArray(hrefParam("employmentId"), employmentIds),
      groupIds.length === 0
        ? undefined
        : and(
            inArray(hrefParam("groupId"), groupIds),
            inArray(notifications.title, accountDeletedTitles(name))
          )
    )
  );

  const aboutExport = organization
    ? and(
        eq(notifications.type, notificationType.ExportReady),
        inArray(
          notifications.userId,
          tx
            .select({ id: readLog.readerUserId })
            .from(readLog)
            .where(
              and(
                eq(readLog.organizationId, organizationId),
                eq(readLog.subjectUserId, userId),
                ne(readLog.audience, readLogAudience.Self)
              )
            )
        ),
        sql`starts_with(${notifications.body}, ${personExportNoticeOpening(name, organization.name)})`
      )
    : undefined;

  const removed = await tx
    .delete(notifications)
    .where(and(ne(notifications.userId, userId), or(aboutBookings, aboutDeletion, aboutExport)))
    .returning({ id: notifications.id });
  return removed.length;
};

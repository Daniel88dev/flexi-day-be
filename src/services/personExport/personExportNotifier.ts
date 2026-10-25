import { eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { notificationType } from "../../db/schema/notification-schema.js";
import { personExportScope } from "../../db/schema/person-export-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { logger } from "../../middleware/logger.js";
import { errorName } from "../../utils/errorName.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { createNotification } from "../notification/notificationServices.js";
import { getPersonContact } from "../person/personName.js";
import { pushNotifications } from "../push/pushServices.js";
import type { PersonExportRow } from "./types.js";

/** How an `export_ready` notice about another person's Person export begins. */
export const personExportNoticeOpening = (personName: string, organizationName: string): string =>
  `The export of ${personName}'s data from ${organizationName} `;

/** In-app and pushed, never emailed. Swallows its own failure: the export is already ready. */
export const notifyExportReady = async (
  row: Pick<
    PersonExportRow,
    "id" | "organizationId" | "scope" | "subjectUserId" | "requestedByUserId"
  >
): Promise<void> => {
  try {
    const [organization] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, row.organizationId));
    const whole = row.scope === personExportScope.Organization;
    const own = row.subjectUserId === row.requestedByUserId;
    const subject =
      own || !row.subjectUserId
        ? undefined
        : await getPersonContact(row.subjectUserId, { organizationId: row.organizationId });
    const organizationName = organization?.name ?? "your organization";

    const notice = await createNotification({
      id: generateRandomUUID(),
      userId: row.requestedByUserId,
      type: notificationType.ExportReady,
      title: "Your export is ready",
      body: whole
        ? `The export of ${organizationName} is ready to download for 7 days.`
        : own
          ? `Your data from ${organizationName} is ready to download for 7 days.`
          : `${personExportNoticeOpening(subject?.name ?? "the person", organizationName)}is ready to download for 7 days.`,
      href: own ? "/settings/" : "/organization/",
    });
    if (notice) await pushNotifications([notice]);
  } catch (error) {
    logger.error("Could not record the export ready notice", {
      exportId: row.id,
      error: errorName(error),
    });
  }
};

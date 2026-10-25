import { eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { notificationType } from "../../db/schema/notification-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { logger } from "../../middleware/logger.js";
import { errorName } from "../../utils/errorName.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { createNotification } from "../notification/notificationServices.js";
import { getPersonContact } from "../person/personName.js";
import { pushNotifications } from "../push/pushServices.js";
import type { PersonExportRow } from "./types.js";

/** In-app and pushed, never emailed. Swallows its own failure: the export is already ready. */
export const notifyExportReady = async (
  row: Pick<PersonExportRow, "id" | "organizationId" | "subjectUserId" | "requestedByUserId">
): Promise<void> => {
  try {
    const [organization] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, row.organizationId));
    const own = row.subjectUserId === row.requestedByUserId;
    const subject = own
      ? undefined
      : await getPersonContact(row.subjectUserId, { organizationId: row.organizationId });
    const organizationName = organization?.name ?? "your organization";

    const notice = await createNotification({
      id: generateRandomUUID(),
      userId: row.requestedByUserId,
      type: notificationType.ExportReady,
      title: "Your export is ready",
      body: own
        ? `Your data from ${organizationName} is ready to download for 7 days.`
        : `The export of ${subject?.name ?? "the person"}'s data from ${organizationName} is ready to download for 7 days.`,
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

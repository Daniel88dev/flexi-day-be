import { and, eq } from "drizzle-orm";
import type { DbTransaction } from "../../db/db.js";
import {
  directoryPermissionRow as R,
  directoryPermissionValue as V,
} from "../../db/schema/directory-schema.js";
import { employments, workerType } from "../../db/schema/employment-schema.js";
import { readLog, readLogAudience, readLogKind } from "../../db/schema/read-log-schema.js";
import { refuse } from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import type { DirectoryViewer } from "./directoryViewer.js";
import {
  contactValuesView,
  personalValuesView,
  readSensitiveSection,
} from "./sensitiveSections.js";
import type { SensitiveSectionName, ShownSection } from "./types.js";

const ROW = { contact: R.Contact, personal: R.Personal } as const;

/**
 * Show: one Sensitive section of one profile, opened. Anyone but the person
 * leaves one read-log row naming the Section and the Audience that granted
 * it, never the values; a self-read leaves none. Run it in the transaction
 * that writes the row, so a value never leaves without its row.
 */
export const showSensitiveSection = async (
  viewer: DirectoryViewer,
  employmentId: string,
  section: SensitiveSectionName,
  tx: DbTransaction
): Promise<ShownSection> => {
  const context = {
    organizationId: viewer.organizationId,
    employmentId,
    viewerUserId: viewer.standing.userId,
    section,
  };
  const [record] = await tx
    .select({
      id: employments.id,
      userId: employments.userId,
      type: employments.type,
      endedAt: employments.endedAt,
    })
    .from(employments)
    .where(
      and(eq(employments.organizationId, viewer.organizationId), eq(employments.id, employmentId))
    );
  const access =
    record && viewer.accessTo({ userId: record.userId, ended: record.endedAt !== null });
  if (!record || !access?.inReach) {
    throw refuse(404, "PERSON_NOT_FOUND", "Person not found", context);
  }
  const row = ROW[section];
  const level = access.sections[row];
  if (level === V.None) {
    throw refuse(403, "SECTION_NOT_READABLE", "You can't read this Section", context);
  }
  if (section === "personal" && record.type === workerType.External) {
    throw refuse(422, "EMPLOYEES_ONLY", "The Personal Section applies to employees only", context);
  }

  const values = await readSensitiveSection(viewer.organizationId, employmentId, tx);
  const self = record.userId !== null && record.userId === viewer.standing.userId;
  if (!self) {
    await tx.insert(readLog).values({
      id: generateRandomUUID(),
      organizationId: viewer.organizationId,
      kind: readLogKind.Read,
      readerUserId: viewer.standing.userId,
      subjectUserId: record.userId,
      employmentIds: [employmentId],
      sections: [row],
      audience: access.grantedBy[row] as unknown as readLogAudience,
    });
  }

  return section === "contact"
    ? {
        section: R.Contact,
        level,
        recorded: !self,
        ...contactValuesView(values.contact, viewer.language),
      }
    : {
        section: R.Personal,
        level,
        recorded: !self,
        ...personalValuesView(values.personal, viewer.language),
      };
};

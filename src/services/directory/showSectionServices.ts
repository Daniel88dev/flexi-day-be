import type { DbTransaction } from "../../db/db.js";
import {
  directoryAudience,
  directoryPermissionRow,
  directoryPermissionValue,
} from "../../db/schema/directory-schema.js";
import { workerType } from "../../db/schema/employment-schema.js";
import { readLog, readLogAudience, readLogKind } from "../../db/schema/read-log-schema.js";
import { refuse } from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { lockRecordInReach, type DirectoryViewer } from "./directoryViewer.js";
import {
  contactValuesView,
  personalValuesView,
  readSensitiveSection,
} from "./sensitiveSections.js";
import { employeesOnly, PERSONAL_EMPLOYEES_ONLY } from "./profileSectionFields.js";
import { sectionRowOf, type SensitiveSectionName } from "./sectionKeys.js";
import type { ShownSection } from "./types.js";

const READ_AUDIENCE: Record<directoryAudience, readLogAudience> = {
  [directoryAudience.Owner]: readLogAudience.Owner,
  [directoryAudience.Self]: readLogAudience.Self,
  [directoryAudience.Colleague]: readLogAudience.Colleague,
  [directoryAudience.ExternalWorker]: readLogAudience.ExternalWorker,
  [directoryAudience.GroupAdmin]: readLogAudience.GroupAdmin,
  [directoryAudience.Hr]: readLogAudience.Hr,
  [directoryAudience.Leadership]: readLogAudience.Leadership,
  [directoryAudience.OrganizationAdmin]: readLogAudience.OrganizationAdmin,
};

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
  const found = await lockRecordInReach(viewer, employmentId, tx, { lock: false });
  const { record, access } = found;
  const context = { ...found.context, section };
  const row = sectionRowOf(section);
  const level = access.sections[row];
  const grantedBy = access.grantedBy[row];
  if (level === directoryPermissionValue.None || grantedBy === null) {
    throw refuse(403, "SECTION_NOT_READABLE", "You can't read this Section", context);
  }
  if (section === "personal" && record.type === workerType.External) {
    throw employeesOnly(PERSONAL_EMPLOYEES_ONLY, context);
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
      audience: READ_AUDIENCE[grantedBy],
    });
  }

  return section === "contact"
    ? {
        section: directoryPermissionRow.Contact,
        level,
        recorded: !self,
        ...contactValuesView(values.contact, viewer.language),
      }
    : {
        section: directoryPermissionRow.Personal,
        level,
        recorded: !self,
        ...personalValuesView(values.personal, viewer.language),
      };
};

import type { DbTransaction } from "../../db/db.js";
import {
  directoryAudience as A,
  directoryPermissionRow as R,
  directoryPermissionValue as V,
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
import type { SensitiveSectionName, ShownSection } from "./types.js";

const ROW = { contact: R.Contact, personal: R.Personal } as const;

const READ_AUDIENCE: Record<A, readLogAudience> = {
  [A.Owner]: readLogAudience.Owner,
  [A.Self]: readLogAudience.Self,
  [A.Colleague]: readLogAudience.Colleague,
  [A.ExternalWorker]: readLogAudience.ExternalWorker,
  [A.GroupAdmin]: readLogAudience.GroupAdmin,
  [A.Hr]: readLogAudience.Hr,
  [A.Leadership]: readLogAudience.Leadership,
  [A.OrganizationAdmin]: readLogAudience.OrganizationAdmin,
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
  const row = ROW[section];
  const level = access.sections[row];
  const grantedBy = access.grantedBy[row];
  if (level === V.None || grantedBy === null) {
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
      audience: READ_AUDIENCE[grantedBy],
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

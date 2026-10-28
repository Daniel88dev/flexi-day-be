import { and, eq, isNotNull } from "drizzle-orm";
import type { DbTransaction } from "../../db/db.js";
import { directoryProfiles } from "../../db/schema/directory-profile-schema.js";
import { directorySensitiveProfiles } from "../../db/schema/directory-sensitive-profile-schema.js";
import { directoryPermissionRow } from "../../db/schema/directory-schema.js";
import { employments, workerType } from "../../db/schema/employment-schema.js";
import { refuse } from "../../utils/appError.js";
import { businessDateInZone } from "../../utils/dateFunc.js";
import { getActiveGroupsForUsersInOrganization } from "../groupUser/groupUserServices.js";
import { organizationTimeZone } from "../organization/attendanceSettingsServices.js";
import { zeroQuotasFromYear } from "../userYearQuotas/userYearQuotasServices.js";
import { getDirectoryProfile } from "./directoryProfileServices.js";
import { lockRecordInReach, type DirectoryViewer } from "./directoryViewer.js";
import { JOB_COLUMNS, PERSONAL_FIELDS } from "./profileSectionFields.js";
import { recordProfileHistory } from "./profileHistory.js";
import type { DirectoryProfile, PutWorkerType } from "./types.js";

/**
 * Change worker type. Turning a record external clears Contract type, Working
 * time, Probation end date and the whole Personal section, drops the
 * required-time override and sets the person's allowances to zero from this
 * year on, all in the caller's transaction. Turning it back restores nothing.
 * Needs the directory on and the act cell, never the plan.
 */
export const changeWorkerType = async (
  viewer: DirectoryViewer,
  employmentId: string,
  input: PutWorkerType,
  tx: DbTransaction
): Promise<DirectoryProfile> => {
  const { organizationId } = viewer;
  const { record, access, context } = await lockRecordInReach(viewer, employmentId, tx);
  const audience = access.actGrantedBy[directoryPermissionRow.ChangeWorkerType];
  if (audience === null) {
    throw refuse(403, "WORKER_TYPE_DENIED", "You can't change this person's worker type", context);
  }
  if (record.endedAt !== null) {
    throw refuse(409, "EMPLOYMENT_ENDED", "This person no longer works here", context);
  }
  if (record.type === input.type) return getDirectoryProfile(viewer, employmentId, tx);

  const history: { section: directoryPermissionRow; fields: string[] }[] = [];

  if (input.type === workerType.External) {
    const [profile] = await tx
      .select()
      .from(directoryProfiles)
      .where(eq(directoryProfiles.employmentId, employmentId));
    const held = (
      [
        [JOB_COLUMNS.probationEndDate, profile?.probationEndDate],
        [JOB_COLUMNS.contractType, profile?.contractType],
        [JOB_COLUMNS.workingTime, profile?.workingTime],
      ] as const
    ).flatMap(([field, value]) => (value == null ? [] : [field]));
    if (held.length > 0) {
      await tx
        .update(directoryProfiles)
        .set({ probationEndDate: null, contractType: null, workingTime: null })
        .where(eq(directoryProfiles.employmentId, employmentId));
      history.push({ section: directoryPermissionRow.Job, fields: held });
    }

    // Clearing a sealed column needs no cipher; like a retention purge, the
    // history names the whole Section rather than decrypting to find what was set.
    const cleared = await tx
      .update(directorySensitiveProfiles)
      .set({ personal: null })
      .where(
        and(
          eq(directorySensitiveProfiles.employmentId, employmentId),
          isNotNull(directorySensitiveProfiles.personal)
        )
      )
      .returning({ id: directorySensitiveProfiles.employmentId });
    if (cleared.length > 0)
      history.push({ section: directoryPermissionRow.Personal, fields: [...PERSONAL_FIELDS] });

    await tx
      .update(employments)
      .set({ requiredMinutesPerDay: null })
      .where(eq(employments.id, employmentId));

    if (record.userId !== null) {
      const groupIds = (
        (await getActiveGroupsForUsersInOrganization(organizationId, [record.userId], tx)).get(
          record.userId
        ) ?? []
      ).map((group) => group.id);
      const year = Number(
        businessDateInZone(new Date(), await organizationTimeZone(organizationId, tx)).slice(0, 4)
      );
      await zeroQuotasFromYear(record.userId, groupIds, year, tx);
    }
  }

  await tx.update(employments).set({ type: input.type }).where(eq(employments.id, employmentId));
  history.push({ section: directoryPermissionRow.ChangeWorkerType, fields: ["type"] });

  await recordProfileHistory(
    history.map(({ section, fields }) => ({
      organizationId,
      employmentId,
      actorUserId: viewer.standing.userId,
      section,
      fields,
      audience,
    })),
    tx
  );

  return getDirectoryProfile(viewer, employmentId, tx);
};

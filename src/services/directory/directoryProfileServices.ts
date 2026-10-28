import { and, eq } from "drizzle-orm";
import type { DbTransaction } from "../../db/db.js";
import {
  directoryPermissionRow,
  directoryPermissionValue,
} from "../../db/schema/directory-schema.js";
import { employments, workerType } from "../../db/schema/employment-schema.js";
import { refuse } from "../../utils/appError.js";
import { countryView, phoneCountryDefault, phoneView } from "./contactFormat.js";
import { readDirectoryRoles } from "./directoryRoleServices.js";
import { isBoundEmployment } from "../employment/boundEmployment.js";
import { profileActions } from "./profileActions.js";
import type { ProfilePhotoView } from "./directoryPhotoServices.js";
import { emergencyContactNotice } from "./emergencyContactNotice.js";
import { copyFromPreviousSpellOffered } from "./previousSpellServices.js";
import { profileRetention, readRetentionSchedules } from "./retentionSchedule.js";
import { getOrganizationById } from "../organization/organizationServices.js";
import { administersPeople, type DirectoryViewer } from "./directoryViewer.js";
import type { DirectoryAccess, SectionRow } from "./permissionResolver.js";
import type { DirectoryProfile, DirectorySectionView } from "./types.js";
import {
  accessFor,
  photoOf,
  selectRecords,
  toPerson,
  departmentOf,
  locationOf,
  type RecordRow,
} from "./directoryRecords.js";

const phoneCountryView = (viewer: DirectoryViewer, record: RecordRow) => {
  const code = phoneCountryDefault({
    locationCountry: record.locationCountry ?? null,
    language: viewer.language,
  });
  return code === null ? null : countryView(code, viewer.language);
};

const sectionsOf = (
  viewer: DirectoryViewer,
  record: RecordRow,
  access: DirectoryAccess,
  photo: ProfilePhotoView | null
): DirectoryProfile["sections"] => {
  const view = (row: SectionRow): DirectorySectionView | undefined => {
    const level = access.sections[row];
    return level === directoryPermissionValue.None ? undefined : { level };
  };
  const card = view(directoryPermissionRow.Card);
  const job = view(directoryPermissionRow.Job);
  const workContact = view(directoryPermissionRow.WorkContact);
  const reachesManager =
    record.reportsToId !== null &&
    viewer.accessTo({ userId: record.reportsToUserId, ended: record.reportsToEndedAt !== null })
      .inReach;
  const sections: DirectoryProfile["sections"] = {
    card: card && {
      ...card,
      jobTitle: record.jobTitle ?? null,
      reportsTo:
        record.reportsToId === null
          ? null
          : {
              employmentId: record.reportsToId,
              name: reachesManager ? record.reportsToName : null,
            },
      nameFromAccount: isBoundEmployment(record),
      department: departmentOf(record),
      location: (() => {
        const location = locationOf(record);
        return (
          location && {
            ...location,
            country: record.locationCountry
              ? countryView(record.locationCountry, viewer.language)
              : null,
          }
        );
      })(),
    },
    photo: (() => {
      const section = view(directoryPermissionRow.Photo);
      return section && { ...section, photo };
    })(),
    workContact: workContact && {
      ...workContact,
      workEmail: record.workEmail ?? null,
      workPhone: record.workPhone ? phoneView(record.workPhone, viewer.language) : null,
      ...(access.sections[directoryPermissionRow.WorkContact] ===
        directoryPermissionValue.Write && {
        phoneCountryDefault: phoneCountryView(viewer, record),
      }),
    },
    job: job && {
      ...job,
      spell: { startedAt: record.startedAt, endedAt: record.endedAt },
      legalName: record.legalName ?? null,
      employeeNumber: record.employeeNumber ?? null,
      startDate: record.startDate ?? null,
      leavingDate: record.leavingDate ?? null,
      probationEndDate: record.probationEndDate ?? null,
      contractType: record.contractType ?? null,
      workingTime: record.workingTime ?? null,
    },
    contact: view(directoryPermissionRow.Contact),
    personal:
      record.type === workerType.External ? undefined : view(directoryPermissionRow.Personal),
  };
  return Object.fromEntries(
    Object.entries(sections).filter(([, section]) => section !== undefined)
  );
};

/**
 * One profile, with only the Sections the viewer reads. 404 `PERSON_NOT_FOUND`
 * when the record belongs elsewhere or is out of the viewer's reach, so the
 * answer never says whether someone exists.
 */
export const getDirectoryProfile = async (
  viewer: DirectoryViewer,
  employmentId: string,
  tx?: DbTransaction
): Promise<DirectoryProfile> => {
  const { query } = selectRecords(viewer.organizationId, tx);
  const [row] = await query
    .where(
      and(eq(employments.organizationId, viewer.organizationId), eq(employments.id, employmentId))
    )
    .limit(1);
  const access = row ? accessFor(viewer, row) : undefined;
  if (!row || !access?.inReach) {
    throw refuse(404, "PERSON_NOT_FOUND", "Person not found", {
      organizationId: viewer.organizationId,
      employmentId,
      viewerUserId: viewer.standing.userId,
    });
  }

  const photo = await photoOf(viewer, row, access);
  const profile: DirectoryProfile = {
    ...toPerson(row, access, photo),
    organizationId: viewer.organizationId,
    self: row.userId !== null && row.userId === viewer.standing.userId,
    ended: row.endedAt !== null,
    sections: sectionsOf(viewer, row, access, photo),
    canReadHistory: administersPeople(viewer),
    actions: profileActions(
      viewer,
      row,
      access,
      await copyFromPreviousSpellOffered(viewer, row, access, tx)
    ),
  };
  if (row.endedAt !== null) {
    const schedule = (await readRetentionSchedules(viewer.organizationId, [row.id], tx)).get(
      row.id
    );
    if (schedule) {
      profile.retention = profileRetention(schedule, access, row.type === workerType.External);
    }
  }
  if (profile.sections.contact?.level === directoryPermissionValue.Write) {
    const organization = await getOrganizationById(viewer.organizationId, tx);
    profile.sections.contact = {
      ...profile.sections.contact,
      notice: await emergencyContactNotice(
        { id: viewer.organizationId, name: organization?.name ?? "" },
        viewer.language,
        tx
      ),
      phoneCountryDefault: phoneCountryView(viewer, row),
    };
  }
  if (access.accountFacts) {
    profile.account = {
      status:
        row.userId === null ? "NO_ACCOUNT" : row.accountDeletedAt !== null ? "DELETED" : "ACTIVE",
      signInEmail: row.email,
      directoryRoles: (await readDirectoryRoles([row.id], tx)).get(row.id) ?? [],
    };
  }
  return profile;
};

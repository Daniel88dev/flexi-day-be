import {
  directoryAudience,
  directoryPermissionRow,
  directoryPermissionValue,
} from "../../db/schema/directory-schema.js";
import { directoryRole } from "../../db/schema/directory-role-schema.js";
import { workerType } from "../../db/schema/employment-schema.js";

export const SECTION_ROWS = [
  directoryPermissionRow.Card,
  directoryPermissionRow.Photo,
  directoryPermissionRow.WorkContact,
  directoryPermissionRow.Job,
  directoryPermissionRow.Contact,
  directoryPermissionRow.Personal,
] as const;
export type SectionRow = (typeof SECTION_ROWS)[number];

export const ACT_ROWS = [
  directoryPermissionRow.CreateAccountlessPerson,
  directoryPermissionRow.SendDirectoryInvite,
  directoryPermissionRow.ChangeWorkerType,
  directoryPermissionRow.EndEmployment,
  directoryPermissionRow.ManageDepartmentsAndLocations,
] as const;
export type ActRow = (typeof ACT_ROWS)[number];

export type SectionLevel =
  directoryPermissionValue.None | directoryPermissionValue.Read | directoryPermissionValue.Write;

export type PermissionCell = {
  row: directoryPermissionRow;
  audience: directoryAudience;
  value: directoryPermissionValue;
};

/** The key of one cell of the Permission table. */
export const cellKey = (row: directoryPermissionRow, audience: directoryAudience) =>
  `${row}/${audience}`;

/** How wide a value is: a Section's None < Read < Write, an act's No < Allowed. */
export const VALUE_RANK: Record<directoryPermissionValue, number> = {
  [directoryPermissionValue.None]: 0,
  [directoryPermissionValue.Read]: 1,
  [directoryPermissionValue.Write]: 2,
  [directoryPermissionValue.No]: 0,
  [directoryPermissionValue.Allowed]: 1,
};

/** Everything about the viewer the resolver needs, loaded once per request. */
export type ViewerStanding = {
  userId: string;
  owner: boolean;
  /** A delegated org-admin grant; the owner is `owner`. */
  organizationAdmin: boolean;
  /** The type of the viewer's open Employment in the organization, if any. */
  employmentType: workerType | null;
  roles: readonly directoryRole[];
  /** User ids the viewer reaches as a Group admin, along the attendance lines. */
  groupAdminReach: ReadonlySet<string>;
};

export type DirectoryRecord = { userId: string | null; ended: boolean };

export type DirectoryAccess = {
  audiences: directoryAudience[];
  sections: Record<SectionRow, SectionLevel>;
  /** The audience whose cell gave each Section its level; null where the viewer reads nothing. */
  grantedBy: Record<SectionRow, directoryAudience | null>;
  acts: Record<ActRow, boolean>;
  /** The audience whose cell allows each act; null where the viewer may not. */
  actGrantedBy: Record<ActRow, directoryAudience | null>;
  /** The viewer reads the Card, so the record shows in their lists and its profile opens. */
  inReach: boolean;
  /** No account, Invite sent and Account deleted. */
  restrictedMarkers: boolean;
  /** Account status, sign-in email and directory roles. */
  accountFacts: boolean;
};

const FORMER_AUDIENCES: readonly directoryAudience[] = [
  directoryAudience.Owner,
  directoryAudience.OrganizationAdmin,
  directoryAudience.Hr,
];
const READ_ONLY_AUDIENCES: readonly directoryAudience[] = [
  directoryAudience.Colleague,
  directoryAudience.ExternalWorker,
];

const audiencesFor = (viewer: ViewerStanding, record: DirectoryRecord): directoryAudience[] => {
  const audiences: directoryAudience[] = [];
  if (viewer.owner) audiences.push(directoryAudience.Owner);
  if (!record.ended && record.userId !== null && record.userId === viewer.userId) {
    audiences.push(directoryAudience.Self);
  }
  if (!record.ended && viewer.employmentType === workerType.Employee)
    audiences.push(directoryAudience.Colleague);
  if (!record.ended && viewer.employmentType === workerType.External) {
    audiences.push(directoryAudience.ExternalWorker);
  }
  if (!record.ended && record.userId !== null && viewer.groupAdminReach.has(record.userId)) {
    audiences.push(directoryAudience.GroupAdmin);
  }
  if (viewer.roles.includes(directoryRole.Hr)) audiences.push(directoryAudience.Hr);
  if (!record.ended && viewer.roles.includes(directoryRole.Leadership))
    audiences.push(directoryAudience.Leadership);
  if (viewer.organizationAdmin) audiences.push(directoryAudience.OrganizationAdmin);
  return audiences;
};

const sectionLevel = (
  stored: directoryPermissionValue | undefined,
  audience: directoryAudience
): SectionLevel => {
  if (audience === directoryAudience.Owner) return directoryPermissionValue.Write;
  const level: SectionLevel =
    stored === directoryPermissionValue.Read || stored === directoryPermissionValue.Write
      ? stored
      : directoryPermissionValue.None;
  if (level === directoryPermissionValue.Write && READ_ONLY_AUDIENCES.includes(audience))
    return directoryPermissionValue.Read;
  return level;
};

/**
 * The viewer's level on each Section of one record, and the acts they may
 * perform on it, from the organization's Permission table. The widest cell of
 * the audiences that credit the viewer wins, on their own record too. The
 * fixed floors hold whatever the stored cells say, and an ended record is
 * reached only through the Owner, Org admin and HR columns.
 */
export const resolveAccess = (
  cells: readonly PermissionCell[],
  viewer: ViewerStanding,
  record: DirectoryRecord
): DirectoryAccess => {
  const audiences = audiencesFor(viewer, record).filter(
    (audience) => !record.ended || FORMER_AUDIENCES.includes(audience)
  );
  const stored = new Map(cells.map((cell) => [cellKey(cell.row, cell.audience), cell.value]));

  const sections = {} as Record<SectionRow, SectionLevel>;
  const grantedBy = {} as Record<SectionRow, directoryAudience | null>;
  for (const row of SECTION_ROWS) {
    const self = audiences.includes(directoryAudience.Self);
    let widest: SectionLevel = self ? directoryPermissionValue.Read : directoryPermissionValue.None;
    let grantor: directoryAudience | null = self ? directoryAudience.Self : null;
    for (const audience of audiences) {
      const level = sectionLevel(stored.get(cellKey(row, audience)), audience);
      if (VALUE_RANK[level] > VALUE_RANK[widest]) {
        widest = level;
        grantor = audience;
      }
    }
    sections[row] = widest;
    grantedBy[row] = grantor;
  }

  const acts = {} as Record<ActRow, boolean>;
  const actGrantedBy = {} as Record<ActRow, directoryAudience | null>;
  for (const row of ACT_ROWS) {
    const grantor = audiences.find(
      (audience) =>
        audience === directoryAudience.Owner ||
        stored.get(cellKey(row, audience)) === directoryPermissionValue.Allowed
    );
    acts[row] = grantor !== undefined;
    actGrantedBy[row] = grantor ?? null;
  }

  const restrictedMarkers = audiences.some((audience) => FORMER_AUDIENCES.includes(audience));
  return {
    audiences,
    sections,
    grantedBy,
    acts,
    actGrantedBy,
    inReach: sections[directoryPermissionRow.Card] !== directoryPermissionValue.None,
    restrictedMarkers,
    accountFacts: restrictedMarkers || audiences.includes(directoryAudience.Self),
  };
};

import {
  directoryAudience as A,
  directoryPermissionRow as R,
  directoryPermissionValue as V,
} from "../../db/schema/directory-schema.js";
import { workerType } from "../../db/schema/employment-schema.js";

export const SECTION_ROWS = [R.Card, R.Photo, R.WorkContact, R.Job, R.Contact, R.Personal] as const;
export type SectionRow = (typeof SECTION_ROWS)[number];

export const ACT_ROWS = [
  R.CreateAccountlessPerson,
  R.SendDirectoryInvite,
  R.ChangeWorkerType,
  R.EndEmployment,
  R.ManageDepartmentsAndLocations,
] as const;
export type ActRow = (typeof ACT_ROWS)[number];

export type SectionLevel = V.None | V.Read | V.Write;
export type DirectoryRole = "HR" | "LEADERSHIP";

export type PermissionCell = { row: R; audience: A; value: V };

/** Everything about the viewer the resolver needs, loaded once per request. */
export type ViewerStanding = {
  userId: string;
  owner: boolean;
  /** A delegated org-admin grant; the owner is `owner`. */
  organizationAdmin: boolean;
  /** The type of the viewer's open Employment in the organization, if any. */
  employmentType: workerType | null;
  roles: readonly DirectoryRole[];
  /** User ids the viewer reaches as a Group admin, along the attendance lines. */
  groupAdminReach: ReadonlySet<string>;
};

export type DirectoryRecord = { userId: string | null; ended: boolean };

export type DirectoryAccess = {
  audiences: A[];
  sections: Record<SectionRow, SectionLevel>;
  acts: Record<ActRow, boolean>;
  /** The viewer reads the Card, so the record shows in their lists and its profile opens. */
  inReach: boolean;
  /** No account, Invite sent and Account deleted. */
  restrictedMarkers: boolean;
  /** Account status, sign-in email and directory roles. */
  accountFacts: boolean;
};

const RANK: Record<SectionLevel, number> = { [V.None]: 0, [V.Read]: 1, [V.Write]: 2 };
const FORMER_AUDIENCES: readonly A[] = [A.Owner, A.OrganizationAdmin, A.Hr];
const READ_ONLY_AUDIENCES: readonly A[] = [A.Colleague, A.ExternalWorker];

const audiencesFor = (viewer: ViewerStanding, record: DirectoryRecord): A[] => {
  const audiences: A[] = [];
  if (viewer.owner) audiences.push(A.Owner);
  if (!record.ended && record.userId !== null && record.userId === viewer.userId) {
    audiences.push(A.Self);
  }
  if (!record.ended && viewer.employmentType === workerType.Employee) audiences.push(A.Colleague);
  if (!record.ended && viewer.employmentType === workerType.External) {
    audiences.push(A.ExternalWorker);
  }
  if (!record.ended && record.userId !== null && viewer.groupAdminReach.has(record.userId)) {
    audiences.push(A.GroupAdmin);
  }
  if (viewer.roles.includes("HR")) audiences.push(A.Hr);
  if (!record.ended && viewer.roles.includes("LEADERSHIP")) audiences.push(A.Leadership);
  if (viewer.organizationAdmin) audiences.push(A.OrganizationAdmin);
  return audiences;
};

const sectionLevel = (stored: V | undefined, audience: A): SectionLevel => {
  if (audience === A.Owner) return V.Write;
  const level: SectionLevel = stored === V.Read || stored === V.Write ? stored : V.None;
  if (level === V.Write && READ_ONLY_AUDIENCES.includes(audience)) return V.Read;
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
  const stored = new Map(cells.map((cell) => [`${cell.row}/${cell.audience}`, cell.value]));

  const sections = {} as Record<SectionRow, SectionLevel>;
  for (const row of SECTION_ROWS) {
    let widest: SectionLevel = audiences.includes(A.Self) ? V.Read : V.None;
    for (const audience of audiences) {
      const level = sectionLevel(stored.get(`${row}/${audience}`), audience);
      if (RANK[level] > RANK[widest]) widest = level;
    }
    sections[row] = widest;
  }

  const acts = {} as Record<ActRow, boolean>;
  for (const row of ACT_ROWS) {
    acts[row] = audiences.some(
      (audience) => audience === A.Owner || stored.get(`${row}/${audience}`) === V.Allowed
    );
  }

  const restrictedMarkers = audiences.some((audience) => FORMER_AUDIENCES.includes(audience));
  return {
    audiences,
    sections,
    acts,
    inReach: sections[R.Card] !== V.None,
    restrictedMarkers,
    accountFacts: restrictedMarkers || audiences.includes(A.Self),
  };
};

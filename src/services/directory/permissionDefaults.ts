import {
  directoryAudience as A,
  directoryPermissionRow as R,
  directoryPermissionValue as V,
} from "../../db/schema/directory-schema.js";

export type PermissionCellDefault = {
  row: R;
  audience: A;
  value: V;
  /** The owner can never change a fixed cell. */
  fixed: boolean;
};

const SECTION_AUDIENCES = [
  A.Owner,
  A.Self,
  A.Colleague,
  A.ExternalWorker,
  A.GroupAdmin,
  A.Hr,
  A.Leadership,
  A.OrganizationAdmin,
] as const;

const N = V.None;
const r = V.Read;
const W = V.Write;

/**
 * Section cells in the audience order above. `true` beside a value marks it
 * fixed. From the default table in fenro T-472.
 */
const SECTIONS: [R, [V, boolean?][]][] = [
  [R.Card, [[W, true], [r, true], [r], [r], [r], [W], [r], [W]]],
  [R.Photo, [[W, true], [W], [r], [r], [r], [W], [r], [W]]],
  [R.WorkContact, [[W, true], [r], [r], [N], [r], [W], [r], [W]]],
  [R.Job, [[W, true], [r, true], [N], [N], [r], [W], [r], [W]]],
  [R.Contact, [[W, true], [W], [N], [N], [N], [W], [N], [W]]],
  [R.Personal, [[W, true], [W], [N], [N], [N], [W], [N], [W]]],
];

const STANDARD_ACT: [A, V][] = [
  [A.GroupAdmin, V.No],
  [A.Hr, V.Allowed],
  [A.Leadership, V.No],
  [A.OrganizationAdmin, V.Allowed],
];

/**
 * Act rows have no Self, Colleague or External worker cell, and the Owner cell
 * is a fixed allowed. Group admin has none on End (T-472); Manage departments
 * and locations comes from T-473.
 */
const ACTS: [R, [A, V][]][] = [
  [R.CreateAccountlessPerson, STANDARD_ACT],
  [R.SendDirectoryInvite, STANDARD_ACT],
  [R.ChangeWorkerType, STANDARD_ACT],
  [R.EndEmployment, STANDARD_ACT.filter(([audience]) => audience !== A.GroupAdmin)],
  [R.ManageDepartmentsAndLocations, STANDARD_ACT],
];

const buildDefaults = (): PermissionCellDefault[] => [
  ...SECTIONS.flatMap(([row, cells]) =>
    cells.map(([value, fixed], index) => ({
      row,
      audience: SECTION_AUDIENCES.at(index)!,
      value,
      fixed: fixed === true,
    }))
  ),
  ...ACTS.flatMap(([row, cells]) => [
    { row, audience: A.Owner, value: V.Allowed, fixed: true },
    ...cells.map(([audience, value]) => ({ row, audience, value, fixed: false })),
  ]),
];

/**
 * The product's default Permission table. Turning the directory on copies it
 * into the organization's own cells; later edits to this list never touch an
 * existing copy, except that a cell added here lands in every copy with its
 * default through a migration (and on the next enable).
 */
export const DIRECTORY_PERMISSION_DEFAULTS: readonly PermissionCellDefault[] = buildDefaults();

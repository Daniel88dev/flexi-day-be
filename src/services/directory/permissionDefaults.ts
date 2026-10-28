import {
  directoryAudience,
  directoryPermissionRow,
  directoryPermissionValue,
} from "../../db/schema/directory-schema.js";

export type PermissionCellDefault = {
  row: directoryPermissionRow;
  audience: directoryAudience;
  value: directoryPermissionValue;
  /** The owner can never change a fixed cell. */
  fixed: boolean;
};

const SECTION_AUDIENCES = [
  directoryAudience.Owner,
  directoryAudience.Self,
  directoryAudience.Colleague,
  directoryAudience.ExternalWorker,
  directoryAudience.GroupAdmin,
  directoryAudience.Hr,
  directoryAudience.Leadership,
  directoryAudience.OrganizationAdmin,
] as const;

const { None, Read, Write } = directoryPermissionValue;

/**
 * Section cells in the audience order above. `true` beside a value marks it
 * fixed.
 */
const SECTIONS: [directoryPermissionRow, [directoryPermissionValue, boolean?][]][] = [
  [
    directoryPermissionRow.Card,
    [[Write, true], [Read, true], [Read], [Read], [Read], [Write], [Read], [Write]],
  ],
  [
    directoryPermissionRow.Photo,
    [[Write, true], [Write], [Read], [Read], [Read], [Write], [Read], [Write]],
  ],
  [
    directoryPermissionRow.WorkContact,
    [[Write, true], [Read], [Read], [None], [Read], [Write], [Read], [Write]],
  ],
  [
    directoryPermissionRow.Job,
    [[Write, true], [Read, true], [None], [None], [Read], [Write], [Read], [Write]],
  ],
  [
    directoryPermissionRow.Contact,
    [[Write, true], [Write], [None], [None], [None], [Write], [None], [Write]],
  ],
  [
    directoryPermissionRow.Personal,
    [[Write, true], [Write], [None], [None], [None], [Write], [None], [Write]],
  ],
];

const STANDARD_ACT: [directoryAudience, directoryPermissionValue][] = [
  [directoryAudience.GroupAdmin, directoryPermissionValue.No],
  [directoryAudience.Hr, directoryPermissionValue.Allowed],
  [directoryAudience.Leadership, directoryPermissionValue.No],
  [directoryAudience.OrganizationAdmin, directoryPermissionValue.Allowed],
];

/**
 * Act rows have no Self, Colleague or External worker cell, and the Owner cell
 * is a fixed allowed.
 */
const ACTS: [directoryPermissionRow, [directoryAudience, directoryPermissionValue][]][] = [
  [directoryPermissionRow.CreateAccountlessPerson, STANDARD_ACT],
  [directoryPermissionRow.SendDirectoryInvite, STANDARD_ACT],
  [directoryPermissionRow.ChangeWorkerType, STANDARD_ACT],
  [
    directoryPermissionRow.EndEmployment,
    STANDARD_ACT.filter(([audience]) => audience !== directoryAudience.GroupAdmin),
  ],
  [directoryPermissionRow.ManageDepartmentsAndLocations, STANDARD_ACT],
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
    {
      row,
      audience: directoryAudience.Owner,
      value: directoryPermissionValue.Allowed,
      fixed: true,
    },
    ...cells.map(([audience, value]) => ({ row, audience, value, fixed: false })),
  ]),
];

/**
 * The product's default Permission table. Turning the directory on copies it
 * into the organization's own cells, and later edits to this list never touch
 * a stored cell. A row added here needs a migration that inserts its default
 * into every stored copy (`docs/directory.md`); until then reads fill it from
 * here, and the owner's next edit or a re-enable stores it.
 */
export const DIRECTORY_PERMISSION_DEFAULTS: readonly PermissionCellDefault[] = buildDefaults();

import {
  directoryAudience as A,
  directoryPermissionRow as R,
  directoryPermissionValue as V,
} from "../../db/schema/directory-schema.js";
import { DIRECTORY_PERMISSION_DEFAULTS } from "./permissionDefaults.js";
import { SECTION_ROWS, type PermissionCell } from "./permissionResolver.js";

export type CellRule = { fixed: boolean; options: V[] };

const SECTION_VALUES = [V.None, V.Read, V.Write];
const ACT_VALUES = [V.No, V.Allowed];
const RANK: Record<V, number> = {
  [V.None]: 0,
  [V.Read]: 1,
  [V.Write]: 2,
  [V.No]: 0,
  [V.Allowed]: 1,
};

const DEFAULTS = new Map(
  DIRECTORY_PERMISSION_DEFAULTS.map((cell) => [`${cell.row}/${cell.audience}`, cell])
);

const isSection = (row: R) => (SECTION_ROWS as readonly R[]).includes(row);

/**
 * What the owner may set in one cell of the Permission table, or null where the
 * table has no cell. The floors live here: the Owner column and the defaults
 * marked fixed can't change, Colleague and External worker never write, and
 * Self always reads their own record.
 */
export const cellRule = (row: R, audience: A): CellRule | null => {
  const cell = DEFAULTS.get(`${row}/${audience}`);
  if (!cell) return null;
  if (cell.fixed) return { fixed: true, options: [cell.value] };
  if (!isSection(row)) return { fixed: false, options: ACT_VALUES };
  if (audience === A.Colleague || audience === A.ExternalWorker) {
    return { fixed: false, options: [V.None, V.Read] };
  }
  if (audience === A.Self) return { fixed: false, options: [V.Read, V.Write] };
  return { fixed: false, options: SECTION_VALUES };
};

export type CellChangeCode = "NO_SUCH_CELL" | "CELL_FIXED" | "VALUE_NOT_OFFERED";

export type CellChangeCheck = { ok: true; widens: boolean } | { ok: false; code: CellChangeCode };

/** Whether the owner may move one cell to `value`, and whether that widens it. */
export const checkCellChange = (
  change: PermissionCell,
  current: { before: V }
): CellChangeCheck => {
  const rule = cellRule(change.row, change.audience);
  if (!rule) return { ok: false, code: "NO_SUCH_CELL" };
  if (rule.fixed) return { ok: false, code: "CELL_FIXED" };
  if (!rule.options.includes(change.value)) return { ok: false, code: "VALUE_NOT_OFFERED" };
  return { ok: true, widens: RANK[change.value] > RANK[current.before] };
};

/**
 * The organization's cells with every cell its stored copy lacks filled in
 * from the product default, a safety net for a row whose migration has not
 * run. A stored cell always wins.
 */
export const withDefaultCells = (stored: readonly PermissionCell[]): PermissionCell[] => {
  const byKey = new Map(stored.map((cell) => [`${cell.row}/${cell.audience}`, cell.value]));
  return DIRECTORY_PERMISSION_DEFAULTS.map(({ row, audience, value }) => ({
    row,
    audience,
    value: byKey.get(`${row}/${audience}`) ?? value,
  }));
};

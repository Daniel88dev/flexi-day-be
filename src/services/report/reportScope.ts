import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { ReportScopeEntry } from "./types.js";

type ScopeColumns = {
  userId: PgColumn;
  groupId: PgColumn;
};

type ScopeFilters = {
  groupIds?: string[];
  userIds?: string[];
};

/**
 * Turns the caller's report scope into a SQL predicate over any table keyed by
 * (userId, groupId).
 *
 * Two access levels combine here: groups the caller can see in full, and
 * groups where they may only see their own rows. Returning `null` means the
 * requested filters leave nothing visible — callers must short-circuit to an
 * empty result rather than running an unfiltered query.
 */
export const buildScopePredicate = (
  scope: ReportScopeEntry[],
  callerId: string,
  cols: ScopeColumns,
  filters: ScopeFilters = {}
): SQL | null => {
  const requested = filters.groupIds ? new Set(filters.groupIds) : null;
  const visible = (entry: ReportScopeEntry) => !requested || requested.has(entry.groupId);

  const fullGroups = scope.filter((e) => e.access === "all" && visible(e)).map((e) => e.groupId);
  const selfGroups = scope.filter((e) => e.access === "self" && visible(e)).map((e) => e.groupId);

  const branches: SQL[] = [];
  if (fullGroups.length > 0) branches.push(inArray(cols.groupId, fullGroups));
  if (selfGroups.length > 0) {
    branches.push(and(inArray(cols.groupId, selfGroups), eq(cols.userId, callerId)) as SQL);
  }

  if (branches.length === 0) return null;

  const accessPredicate = branches.length === 1 ? branches[0]! : (or(...branches) as SQL);

  if (!filters.userIds || filters.userIds.length === 0) return accessPredicate;

  return and(accessPredicate, inArray(cols.userId, filters.userIds)) as SQL;
};

/**
 * True when the caller may see every member's records in the group, not just
 * their own. Also gates the dashboard's group calendar, so a plain member
 * without view access never sees who else is off.
 */
export const canViewWholeGroup = (scope: ReportScopeEntry[], groupId: string): boolean =>
  scope.some((entry) => entry.groupId === groupId && entry.access === "all");

/** True when the caller may edit quotas in the group — group admin or manager. */
export const canEditQuotasIn = (scope: ReportScopeEntry[], groupId: string): boolean =>
  scope.some((entry) => entry.groupId === groupId && entry.canEditQuotas);

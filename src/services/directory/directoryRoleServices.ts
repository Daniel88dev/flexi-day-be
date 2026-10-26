import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import {
  directoryPermissionHistory,
  directoryRole,
  directoryRoleAssignments,
  permissionHistoryKind,
  roleChangeReason,
} from "../../db/schema/directory-role-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";

const ROLE_ORDER = [directoryRole.Hr, directoryRole.Leadership];

export const sortRoles = (roles: Iterable<directoryRole>): directoryRole[] => {
  const held = new Set(roles);
  return ROLE_ORDER.filter((role) => held.has(role));
};

/**
 * The Directory roles held on each of the given Employments, counting only
 * open Employments with a live account: a role ends with its Employment.
 */
export const readDirectoryRoles = async (
  employmentIds: string[],
  tx?: DbTransaction
): Promise<Map<string, directoryRole[]>> => {
  if (employmentIds.length === 0) return new Map();
  const rows = await (tx ?? db)
    .select({
      employmentId: directoryRoleAssignments.employmentId,
      role: directoryRoleAssignments.role,
    })
    .from(directoryRoleAssignments)
    .innerJoin(employments, eq(employments.id, directoryRoleAssignments.employmentId))
    .where(
      and(
        inArray(directoryRoleAssignments.employmentId, employmentIds),
        isNull(employments.endedAt),
        isNotNull(employments.userId),
        isNull(employments.accountDeletedAt)
      )
    )
    .orderBy(asc(directoryRoleAssignments.role));
  const byEmployment = new Map<string, directoryRole[]>();
  for (const { employmentId, role } of rows) {
    byEmployment.set(employmentId, sortRoles([...(byEmployment.get(employmentId) ?? []), role]));
  }
  return byEmployment;
};

/**
 * Removes every Directory role held on the given Employments and records each
 * removal in the Permission history. Ending an Employment and deleting an
 * account call it in their own transaction.
 */
export const endDirectoryRoles = async (
  input: { employmentIds: string[]; reason: roleChangeReason; actorUserId: string | null },
  tx?: DbTransaction
): Promise<void> => {
  if (input.employmentIds.length === 0) return;
  const client = tx ?? db;
  const removed = await client
    .delete(directoryRoleAssignments)
    .where(inArray(directoryRoleAssignments.employmentId, input.employmentIds))
    .returning();
  if (removed.length === 0) return;
  await client.insert(directoryPermissionHistory).values(
    removed.map((assignment) => ({
      id: generateRandomUUID(),
      organizationId: assignment.organizationId,
      actorUserId: input.actorUserId,
      kind: permissionHistoryKind.Role,
      role: assignment.role,
      employmentId: assignment.employmentId,
      heldBefore: true,
      heldAfter: false,
      reason: input.reason,
    }))
  );
};

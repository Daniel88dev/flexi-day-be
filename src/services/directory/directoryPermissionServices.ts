import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import {
  directoryPermissionHistory,
  directoryRole,
  directoryRoleAssignments,
  permissionHistoryKind,
  roleChangeReason,
} from "../../db/schema/directory-role-schema.js";
import { directoryPermissionCells } from "../../db/schema/directory-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { refuse } from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { assertDirectoryWritable, isDirectoryWritable } from "../billing/guards.js";
import { lockOrganization } from "../organization/organizationServices.js";
import { getActorNames } from "../person/personName.js";
import { recordName } from "./recordName.js";
import { readDirectoryRoles, sortRoles } from "./directoryRoleServices.js";
import { readPermissionCells, storeMissingCells } from "./directorySettingsServices.js";
import { administersPeople, type DirectoryViewer } from "./directoryViewer.js";
import { cellRule, checkCellChange } from "./permissionTable.js";
import type {
  DirectoryRoles,
  PatchPermissionCell,
  PermissionHistoryEntry,
  PermissionTable,
} from "./types.js";
import { boundEmployment } from "../employment/boundEmployment.js";

const contextOf = (viewer: DirectoryViewer) => ({
  organizationId: viewer.organizationId,
  viewerUserId: viewer.standing.userId,
});

const assertCanRead = (viewer: DirectoryViewer) => {
  if (!administersPeople(viewer)) {
    throw refuse(
      403,
      "PERMISSIONS_DENIED",
      "Only the owner, org admins and HR see the Permission table",
      contextOf(viewer)
    );
  }
};

const assertOwner = (viewer: DirectoryViewer) => {
  if (!viewer.standing.owner) {
    throw refuse(
      403,
      "OWNER_ONLY",
      "Only the organization owner changes the Permission table and Directory roles",
      contextOf(viewer)
    );
  }
};

export const readPermissionTable = async (
  viewer: DirectoryViewer,
  tx?: DbTransaction
): Promise<PermissionTable> => {
  assertCanRead(viewer);
  const cells = await readPermissionCells(viewer.organizationId, tx);
  return {
    editable: viewer.standing.owner,
    writable: await isDirectoryWritable(viewer.organizationId, tx),
    cells: cells.map((cell) => ({ ...cell, ...cellRule(cell.row, cell.audience)! })),
  };
};

/**
 * The owner sets one cell. Fixed cells, values the cell doesn't offer and
 * cells the table lacks are refused with 422. While the plan is lapsed only a
 * narrowing goes through (402 otherwise). A change writes one Permission
 * history entry; setting a cell to its current value writes none.
 */
export const changePermissionCell = async (
  viewer: DirectoryViewer,
  change: PatchPermissionCell,
  tx: DbTransaction
): Promise<PermissionTable> => {
  assertOwner(viewer);
  const { organizationId } = viewer;
  await lockOrganization(organizationId, tx);
  await storeMissingCells(organizationId, tx);

  const current = (await readPermissionCells(organizationId, tx)).find(
    (cell) => cell.row === change.row && cell.audience === change.audience
  );
  const check = checkCellChange(change, { before: current?.value ?? change.value });
  if (!check.ok || !current) {
    throw refuse(
      422,
      check.ok ? "NO_SUCH_CELL" : check.code,
      "The Permission table doesn't take that value in that cell",
      { ...contextOf(viewer), ...change }
    );
  }
  if (check.widens) await assertDirectoryWritable(organizationId, tx);

  if (current.value !== change.value) {
    await tx
      .insert(directoryPermissionCells)
      .values({ organizationId, ...change })
      .onConflictDoUpdate({
        target: [
          directoryPermissionCells.organizationId,
          directoryPermissionCells.row,
          directoryPermissionCells.audience,
        ],
        set: { value: change.value },
      });
    await tx.insert(directoryPermissionHistory).values({
      id: generateRandomUUID(),
      organizationId,
      actorUserId: viewer.standing.userId,
      kind: permissionHistoryKind.Cell,
      row: change.row,
      audience: change.audience,
      valueBefore: current.value,
      valueAfter: change.value,
    });
  }
  return readPermissionTable(viewer, tx);
};

const eligibleRecords = (organizationId: string, tx?: DbTransaction) =>
  (tx ?? db)
    .select({ employmentId: employments.id, name: recordName(employments, user, organizationId) })
    .from(employments)
    .innerJoin(user, eq(user.id, employments.userId))
    .where(and(eq(employments.organizationId, organizationId), boundEmployment()))
    .orderBy(
      asc(sql`lower(${recordName(employments, user, organizationId)})`),
      asc(employments.id)
    );

/** Everyone who may hold a Directory role, with the roles they hold. */
export const listDirectoryRoles = async (
  viewer: DirectoryViewer,
  tx?: DbTransaction
): Promise<DirectoryRoles> => {
  assertCanRead(viewer);
  const people = await eligibleRecords(viewer.organizationId, tx);
  const roles = await readDirectoryRoles(
    people.map((person) => person.employmentId),
    tx
  );
  return {
    editable: viewer.standing.owner,
    writable: await isDirectoryWritable(viewer.organizationId, tx),
    people: people.map((person) => ({ ...person, roles: roles.get(person.employmentId) ?? [] })),
  };
};

/**
 * The owner sets the Directory roles one Employment holds. Only an open
 * Employment with a live account may hold one (422 `NO_ACCOUNT`,
 * `EMPLOYMENT_ENDED`, `ACCOUNT_DELETED`). Adding a role widens access, so it
 * needs the directory plan; removing one never does. Each role added or
 * removed writes a Permission history entry.
 */
export const setDirectoryRoles = async (
  viewer: DirectoryViewer,
  employmentId: string,
  wanted: directoryRole[],
  tx: DbTransaction
): Promise<DirectoryRoles> => {
  assertOwner(viewer);
  const { organizationId } = viewer;
  const context = { ...contextOf(viewer), employmentId };
  await lockOrganization(organizationId, tx);

  const [employment] = await tx
    .select()
    .from(employments)
    .where(and(eq(employments.id, employmentId), eq(employments.organizationId, organizationId)))
    .for("update");
  if (!employment) throw refuse(404, "PERSON_NOT_FOUND", "Person not found", context);

  const held = new Set(
    (
      await tx
        .select({ role: directoryRoleAssignments.role })
        .from(directoryRoleAssignments)
        .where(eq(directoryRoleAssignments.employmentId, employmentId))
    ).map((row) => row.role)
  );
  const target = new Set(wanted);
  const added = sortRoles([...target].filter((role) => !held.has(role)));
  const removed = sortRoles([...held].filter((role) => !target.has(role)));

  if (added.length > 0) {
    if (employment.userId === null) {
      throw refuse(422, "NO_ACCOUNT", "A person without an account can't hold a role", context);
    }
    if (employment.endedAt !== null) {
      throw refuse(422, "EMPLOYMENT_ENDED", "An ended Employment can't hold a role", context);
    }
    if (employment.accountDeletedAt !== null) {
      throw refuse(422, "ACCOUNT_DELETED", "A Deleted account can't hold a role", context);
    }
    await assertDirectoryWritable(organizationId, tx);
    await tx.insert(directoryRoleAssignments).values(
      added.map((role) => ({
        employmentId,
        role,
        organizationId,
        assignedByUserId: viewer.standing.userId,
      }))
    );
  }
  for (const role of removed) {
    await tx
      .delete(directoryRoleAssignments)
      .where(
        and(
          eq(directoryRoleAssignments.employmentId, employmentId),
          eq(directoryRoleAssignments.role, role)
        )
      );
  }

  const changes = [
    ...added.map((role) => ({ role, heldBefore: false, heldAfter: true })),
    ...removed.map((role) => ({ role, heldBefore: true, heldAfter: false })),
  ];
  if (changes.length > 0) {
    await tx.insert(directoryPermissionHistory).values(
      changes.map((change) => ({
        id: generateRandomUUID(),
        organizationId,
        actorUserId: viewer.standing.userId,
        kind: permissionHistoryKind.Role,
        employmentId,
        reason: roleChangeReason.Owner,
        ...change,
      }))
    );
  }
  return listDirectoryRoles(viewer, tx);
};

/** Every change to the table and its roles, newest first. Owner, org admins and HR. */
export const listPermissionHistory = async (
  viewer: DirectoryViewer,
  tx?: DbTransaction
): Promise<PermissionHistoryEntry[]> => {
  assertCanRead(viewer);
  const { organizationId } = viewer;
  const rows = await (tx ?? db)
    .select({
      entry: directoryPermissionHistory,
      personName: sql<
        string | null
      >`case when ${employments.id} is null then null else ${recordName(
        employments,
        user,
        organizationId
      )} end`,
    })
    .from(directoryPermissionHistory)
    .leftJoin(employments, eq(employments.id, directoryPermissionHistory.employmentId))
    .leftJoin(user, eq(user.id, employments.userId))
    .where(eq(directoryPermissionHistory.organizationId, organizationId))
    .orderBy(desc(directoryPermissionHistory.createdAt), desc(directoryPermissionHistory.id));

  const actorName = await getActorNames(
    rows.map(({ entry }) => entry.actorUserId),
    { organizationId }
  );

  return rows.map(({ entry, personName }): PermissionHistoryEntry => {
    const base = {
      id: entry.id,
      at: entry.createdAt,
      actorName: actorName(entry.actorUserId),
    };
    if (entry.kind === permissionHistoryKind.Cell) {
      return {
        kind: "CELL",
        ...base,
        row: entry.row!,
        audience: entry.audience!,
        before: entry.valueBefore,
        after: entry.valueAfter!,
      };
    }
    return {
      kind: "ROLE",
      ...base,
      role: entry.role!,
      employmentId: entry.employmentId,
      personName,
      before: entry.heldBefore === true,
      after: entry.heldAfter === true,
      reason: entry.reason ?? roleChangeReason.Owner,
    };
  });
};

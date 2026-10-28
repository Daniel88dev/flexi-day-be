import { and, asc, eq, ne, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { directoryDepartments, directoryLocations } from "../../db/schema/directory-list-schema.js";
import { directoryProfiles } from "../../db/schema/directory-profile-schema.js";
import { directoryPermissionRow } from "../../db/schema/directory-schema.js";
import type { appLanguage } from "../../db/schema/user-settings-schema.js";
import { refuse } from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { assertDirectoryWritable, isDirectoryWritable } from "../billing/guards.js";
import { countryView, isCountryCode } from "./contactFormat.js";
import type { DirectoryViewer } from "./directoryViewer.js";
import type {
  DirectoryList,
  DirectoryListEntry,
  DirectoryListKind,
  PatchListEntry,
  PostListEntry,
} from "./types.js";

type EntryRow = {
  id: string;
  name: string;
  archivedAt: Date | null;
  country?: string | null;
};

type EntryValues = { id: string; organizationId: string; name: string };
type EntryChanges = { name?: string; archivedAt: Date | null };

/** Everything that differs between the two lists. Only Locations carry a country. */
type ListSpec = {
  table: typeof directoryDepartments | typeof directoryLocations;
  profileColumn: typeof directoryProfiles.departmentId | typeof directoryProfiles.locationId;
  countryColumn: typeof directoryLocations.country | null;
  insert: (tx: DbTransaction, values: EntryValues, country: string | null) => Promise<EntryRow>;
  update: (
    tx: DbTransaction,
    entryId: string,
    changes: EntryChanges,
    country: string | null | undefined
  ) => Promise<EntryRow>;
};

const DEPARTMENTS: ListSpec = {
  table: directoryDepartments,
  profileColumn: directoryProfiles.departmentId,
  countryColumn: null,
  insert: async (tx, values) =>
    (await tx.insert(directoryDepartments).values(values).returning())[0]!,
  update: async (tx, entryId, changes) =>
    (
      await tx
        .update(directoryDepartments)
        .set(changes)
        .where(eq(directoryDepartments.id, entryId))
        .returning()
    )[0]!,
};

const LOCATIONS: ListSpec = {
  table: directoryLocations,
  profileColumn: directoryProfiles.locationId,
  countryColumn: directoryLocations.country,
  insert: async (tx, values, country) =>
    (
      await tx
        .insert(directoryLocations)
        .values({ ...values, country })
        .returning()
    )[0]!,
  update: async (tx, entryId, changes, country) =>
    (
      await tx
        .update(directoryLocations)
        .set({ ...changes, ...(country !== undefined && { country }) })
        .where(eq(directoryLocations.id, entryId))
        .returning()
    )[0]!,
};

const listOf = (kind: DirectoryListKind): ListSpec =>
  kind === "locations" ? LOCATIONS : DEPARTMENTS;

const contextOf = (viewer: DirectoryViewer, kind: DirectoryListKind) => ({
  organizationId: viewer.organizationId,
  viewerUserId: viewer.standing.userId,
  list: kind,
});

/**
 * The Manage departments and locations act cell. The act has no record, so it
 * resolves on a synthetic open one; Group admin credits only on a record in
 * reach, so the synthetic record is one of the people the viewer reaches.
 */
export const canManageLists = (viewer: DirectoryViewer): boolean => {
  const [reached] = viewer.standing.groupAdminReach;
  return viewer.accessTo({ userId: reached ?? null, ended: false }).acts[
    directoryPermissionRow.ManageDepartmentsAndLocations
  ];
};

const assertCanManage = (viewer: DirectoryViewer, kind: DirectoryListKind) => {
  if (!canManageLists(viewer)) {
    throw refuse(
      403,
      "LISTS_DENIED",
      "You can't manage departments and locations",
      contextOf(viewer, kind)
    );
  }
};

const entryView = (
  kind: DirectoryListKind,
  row: EntryRow,
  language: appLanguage,
  inUse?: boolean
): DirectoryListEntry => ({
  id: row.id,
  name: row.name,
  archived: row.archivedAt !== null,
  ...(listOf(kind).countryColumn && {
    country: row.country ? countryView(row.country, language) : null,
  }),
  ...(inUse !== undefined && { inUse }),
});

const inUseSql = (kind: DirectoryListKind, entryId: unknown) =>
  sql<boolean>`exists (select 1 from ${directoryProfiles} where ${listOf(kind).profileColumn} = ${entryId})`;

const isInUse = async (kind: DirectoryListKind, entryId: string, tx: DbTransaction) => {
  const [row] = await tx
    .select({ id: directoryProfiles.employmentId })
    .from(directoryProfiles)
    .where(eq(listOf(kind).profileColumn, entryId))
    .limit(1);
  return row !== undefined;
};

/** Every entry of one list, archived ones included, by name. Anyone in the directory reads it. */
export const readDirectoryList = async (
  viewer: DirectoryViewer,
  kind: DirectoryListKind,
  tx?: DbTransaction
): Promise<DirectoryList> => {
  const { table, countryColumn } = listOf(kind);
  const editable = canManageLists(viewer);
  const rows = await (tx ?? db)
    .select({
      id: table.id,
      name: table.name,
      archivedAt: table.archivedAt,
      ...(countryColumn && { country: countryColumn }),
      inUse: inUseSql(kind, table.id),
    })
    .from(table)
    .where(eq(table.organizationId, viewer.organizationId))
    .orderBy(asc(sql`lower(${table.name})`), asc(table.id));
  return {
    editable,
    writable: await isDirectoryWritable(viewer.organizationId, tx),
    entries: rows.map((row) =>
      entryView(kind, row, viewer.language, editable ? row.inUse : undefined)
    ),
  };
};

const assertNameFree = async (
  viewer: DirectoryViewer,
  kind: DirectoryListKind,
  name: string,
  exceptId: string | null,
  tx: DbTransaction
) => {
  const { table } = listOf(kind);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`directory-list:${kind}:${viewer.organizationId}`}, 0))`
  );
  const [clash] = await tx
    .select({ id: table.id })
    .from(table)
    .where(
      and(
        eq(table.organizationId, viewer.organizationId),
        sql`lower(${table.name}) = lower(${name})`,
        ...(exceptId ? [ne(table.id, exceptId)] : [])
      )
    )
    .limit(1);
  if (clash) {
    throw refuse(409, "NAME_TAKEN", "The list already has an entry with this name", {
      ...contextOf(viewer, kind),
      name,
    });
  }
};

const assertCountry = (viewer: DirectoryViewer, kind: DirectoryListKind, country: string) => {
  if (!isCountryCode(country)) {
    throw refuse(422, "INVALID_COUNTRY", "That isn't a country code", {
      ...contextOf(viewer, kind),
      country,
    });
  }
};

/** Adds an entry. Adding needs the directory plan. */
export const addDirectoryListEntry = async (
  viewer: DirectoryViewer,
  kind: DirectoryListKind,
  body: PostListEntry,
  tx: DbTransaction
): Promise<DirectoryListEntry> => {
  assertCanManage(viewer, kind);
  const country = body.country ?? null;
  if (country !== null) assertCountry(viewer, kind, country);
  await assertDirectoryWritable(viewer.organizationId, tx);
  await assertNameFree(viewer, kind, body.name, null, tx);

  const values = {
    id: generateRandomUUID(),
    organizationId: viewer.organizationId,
    name: body.name,
  };
  const row = await listOf(kind).insert(tx, values, country);
  return entryView(kind, row, viewer.language, false);
};

const lockEntry = async (
  viewer: DirectoryViewer,
  kind: DirectoryListKind,
  entryId: string,
  tx: DbTransaction
): Promise<EntryRow> => {
  const { table } = listOf(kind);
  const [row] = await tx
    .select()
    .from(table)
    .where(and(eq(table.organizationId, viewer.organizationId), eq(table.id, entryId)))
    .for("update");
  if (!row) {
    throw refuse(404, "ENTRY_NOT_FOUND", "No such entry", { ...contextOf(viewer, kind), entryId });
  }
  return row;
};

/**
 * Renames, archives, restores, or sets a Location's country. Renaming,
 * archiving and clearing the country work on every plan; restoring an
 * archived entry or setting a country is a new value and needs the plan.
 */
export const updateDirectoryListEntry = async (
  viewer: DirectoryViewer,
  kind: DirectoryListKind,
  entryId: string,
  body: PatchListEntry,
  tx: DbTransaction
): Promise<DirectoryListEntry> => {
  assertCanManage(viewer, kind);
  const row = await lockEntry(viewer, kind, entryId, tx);
  const country = body.country;
  if (country) assertCountry(viewer, kind, country);
  const restores = body.archived === false && row.archivedAt !== null;
  const setsCountry = country != null && country !== row.country;
  if (restores || setsCountry) await assertDirectoryWritable(viewer.organizationId, tx);
  if (body.name !== undefined && body.name !== row.name) {
    await assertNameFree(viewer, kind, body.name, entryId, tx);
  }

  const archivedAt =
    body.archived === undefined
      ? row.archivedAt
      : body.archived
        ? (row.archivedAt ?? new Date())
        : null;
  const changes = {
    ...(body.name !== undefined && { name: body.name }),
    archivedAt,
  };
  const updated = await listOf(kind).update(tx, entryId, changes, country);
  return entryView(kind, updated, viewer.language, await isInUse(kind, entryId, tx));
};

/** Deletes an entry no Profile holds, open or former. One in use can only be archived. */
export const deleteDirectoryListEntry = async (
  viewer: DirectoryViewer,
  kind: DirectoryListKind,
  entryId: string,
  tx: DbTransaction
): Promise<void> => {
  assertCanManage(viewer, kind);
  await lockEntry(viewer, kind, entryId, tx);
  if (await isInUse(kind, entryId, tx)) {
    throw refuse(409, "ENTRY_IN_USE", "A record holds this entry; archive it instead", {
      ...contextOf(viewer, kind),
      entryId,
    });
  }
  const { table } = listOf(kind);
  await tx.delete(table).where(eq(table.id, entryId));
};

/**
 * Checks a Department or Location a Card write newly gives a record: an entry
 * of the organization that isn't archived. Share-locks the entry so a
 * concurrent delete waits and then sees it in use.
 */
export const assertAssignableEntry = async (
  kind: DirectoryListKind,
  organizationId: string,
  entryId: string,
  context: object,
  tx: DbTransaction
) => {
  const { table } = listOf(kind);
  const [row] = await tx
    .select({ id: table.id, archivedAt: table.archivedAt })
    .from(table)
    .where(and(eq(table.organizationId, organizationId), eq(table.id, entryId)))
    .for("share");
  if (!row) {
    throw refuse(422, "ENTRY_NOT_FOUND", "No such entry in this organization's list", {
      ...context,
      list: kind,
    });
  }
  if (row.archivedAt !== null) {
    throw refuse(422, "ENTRY_ARCHIVED", "An archived entry can't be given to anyone new", {
      ...context,
      list: kind,
    });
  }
};

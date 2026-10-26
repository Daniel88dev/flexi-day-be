import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import {
  directoryAgreementAcceptances,
  directoryPermissionCells,
  organizationDirectorySettings,
} from "../../db/schema/directory-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { inviteLink } from "../../db/schema/invite-link-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { refuse } from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { assertDirectoryWritable, isDirectoryWritable } from "../billing/guards.js";
import {
  getAdminOrganizationsForUser,
  lockOrganization,
} from "../organization/organizationServices.js";
import { personName } from "../person/personName.js";
import { DIRECTORY_AGREEMENT_VERSION } from "./directoryAgreement.js";
import { DIRECTORY_PERMISSION_DEFAULTS } from "./permissionDefaults.js";
import { withDefaultCells } from "./permissionTable.js";
import type {
  DirectoryAgreementState,
  DirectoryOrganization,
  DirectoryOrganizationRole,
  DirectoryState,
} from "./types.js";

type Actor = { organizationId: string; userId: string };

export const getDirectorySettings = async (organizationId: string, tx?: DbTransaction) => {
  const [row] = await (tx ?? db)
    .select()
    .from(organizationDirectorySettings)
    .where(eq(organizationDirectorySettings.organizationId, organizationId))
    .limit(1);
  return row;
};

/** Whether the organization is a Directory organization: the stored toggle, whatever the plan. */
export const isDirectoryOrganization = async (
  organizationId: string,
  tx?: DbTransaction
): Promise<boolean> => (await getDirectorySettings(organizationId, tx))?.enabled === true;

const readAgreement = async (
  organizationId: string,
  enabled: boolean,
  tx?: DbTransaction
): Promise<DirectoryAgreementState> => {
  const [latest] = await (tx ?? db)
    .select({
      version: directoryAgreementAcceptances.version,
      acceptedAt: directoryAgreementAcceptances.acceptedAt,
      acceptedByName: personName(user, { organizationId }),
    })
    .from(directoryAgreementAcceptances)
    .leftJoin(user, eq(directoryAgreementAcceptances.acceptedByUserId, user.id))
    .where(eq(directoryAgreementAcceptances.organizationId, organizationId))
    .orderBy(desc(directoryAgreementAcceptances.acceptedAt))
    .limit(1);

  const acceptedVersion = latest?.version ?? null;
  return {
    currentVersion: DIRECTORY_AGREEMENT_VERSION,
    acceptedVersion,
    acceptedAt: latest?.acceptedAt ?? null,
    acceptedByName: latest?.acceptedByName ?? null,
    newVersionReady:
      enabled && acceptedVersion !== null && acceptedVersion < DIRECTORY_AGREEMENT_VERSION,
  };
};

export const countDirectoryPeople = async (organizationId: string, tx?: DbTransaction) => {
  const [row] = await (tx ?? db)
    .select({
      open: sql<number>`count(*) filter (where ${employments.endedAt} is null)`.mapWith(Number),
      former: sql<number>`count(*) filter (where ${employments.endedAt} is not null)`.mapWith(
        Number
      ),
    })
    .from(employments)
    .where(eq(employments.organizationId, organizationId));
  return { open: row?.open ?? 0, former: row?.former ?? 0 };
};

export const readDirectoryState = async (
  organizationId: string,
  tx?: DbTransaction
): Promise<DirectoryState> => {
  const settings = await getDirectorySettings(organizationId, tx);
  const enabled = settings?.enabled === true;
  return {
    organizationId,
    enabled,
    enabledAt: settings?.enabledAt ?? null,
    disabledAt: settings?.disabledAt ?? null,
    dataDeletedAt: settings?.dataDeletedAt ?? null,
    writable: await isDirectoryWritable(organizationId, tx),
    agreement: await readAgreement(organizationId, enabled, tx),
    people: await countDirectoryPeople(organizationId, tx),
  };
};

const assertCurrentAgreement = (agreementVersion: number, context: object) => {
  if (agreementVersion !== DIRECTORY_AGREEMENT_VERSION) {
    throw refuse(
      409,
      "AGREEMENT_VERSION_STALE",
      "The directory agreement has changed; read the current version",
      { ...context, agreementVersion, currentVersion: DIRECTORY_AGREEMENT_VERSION }
    );
  }
};

const recordAcceptance = async ({ organizationId, userId }: Actor, tx: DbTransaction) => {
  await tx.insert(directoryAgreementAcceptances).values({
    id: generateRandomUUID(),
    organizationId,
    version: DIRECTORY_AGREEMENT_VERSION,
    acceptedByUserId: userId,
  });
};

/**
 * Turns the directory on: the settings row, an acceptance row and the
 * organization's copy of the Permission table, in the caller's transaction.
 * The copy never overwrites a stored cell, so a re-enable brings the
 * organization's own table back and only adds cells the product gained since.
 * The caller checks the owner first.
 */
export const enableDirectory = async (
  input: Actor & { agreementVersion: number },
  tx: DbTransaction
): Promise<void> => {
  const { organizationId, userId } = input;
  await lockOrganization(organizationId, tx);
  await assertDirectoryWritable(organizationId, tx);

  const settings = await getDirectorySettings(organizationId, tx);
  if (settings?.enabled) {
    throw refuse(409, "DIRECTORY_ALREADY_ON", "The directory is already on", { organizationId });
  }
  assertCurrentAgreement(input.agreementVersion, { organizationId });

  const now = new Date();
  await tx
    .insert(organizationDirectorySettings)
    .values({ organizationId, enabled: true, enabledAt: now, enabledByUserId: userId })
    .onConflictDoUpdate({
      target: organizationDirectorySettings.organizationId,
      set: { enabled: true, enabledAt: now, enabledByUserId: userId },
    });
  await recordAcceptance(input, tx);
  await tx
    .insert(directoryPermissionCells)
    .values(
      DIRECTORY_PERMISSION_DEFAULTS.map(({ row, audience, value }) => ({
        organizationId,
        row,
        audience,
        value,
      }))
    )
    .onConflictDoNothing();
};

/**
 * Turns the directory off. Never plan-gated and ends nobody. Open directory
 * invites that name no group are revoked: outside the directory they lead
 * nowhere. Invites naming a group stay valid and still claim. A second call
 * changes nothing.
 */
export const disableDirectory = async (input: Actor, tx: DbTransaction): Promise<void> => {
  const { organizationId, userId } = input;
  await lockOrganization(organizationId, tx);
  const settings = await getDirectorySettings(organizationId, tx);
  if (!settings?.enabled) return;

  await tx
    .update(organizationDirectorySettings)
    .set({ enabled: false, disabledAt: new Date(), disabledByUserId: userId })
    .where(eq(organizationDirectorySettings.organizationId, organizationId));
  await tx
    .update(inviteLink)
    .set({ revokedAt: new Date() })
    .where(
      and(
        isNull(inviteLink.groupId),
        isNull(inviteLink.usedAt),
        isNull(inviteLink.revokedAt),
        inArray(
          inviteLink.employmentId,
          tx
            .select({ id: employments.id })
            .from(employments)
            .where(eq(employments.organizationId, organizationId))
        )
      )
    );
};

/** The owner accepts a new agreement version while the directory is on. Never plan-gated. */
export const acceptDirectoryAgreement = async (
  input: Actor & { agreementVersion: number },
  tx: DbTransaction
): Promise<void> => {
  const { organizationId } = input;
  await lockOrganization(organizationId, tx);
  if (!(await isDirectoryOrganization(organizationId, tx))) {
    throw refuse(409, "DIRECTORY_OFF", "Turn the directory on to accept its agreement", {
      organizationId,
    });
  }
  assertCurrentAgreement(input.agreementVersion, { organizationId });
  await recordAcceptance(input, tx);
};

/** The organization's Permission table, a cell its copy lacks read as the product default. */
export const readPermissionCells = async (organizationId: string, tx?: DbTransaction) =>
  withDefaultCells(
    await (tx ?? db)
      .select({
        row: directoryPermissionCells.row,
        audience: directoryPermissionCells.audience,
        value: directoryPermissionCells.value,
      })
      .from(directoryPermissionCells)
      .where(eq(directoryPermissionCells.organizationId, organizationId))
  );

/**
 * The organizations whose directory concerns the caller: every one they own or
 * administer, plus every one where they hold an open Employment. The web builds
 * the People section from it.
 */
export const listDirectoryOrganizations = async (
  userId: string
): Promise<DirectoryOrganization[]> => {
  const administered = await getAdminOrganizationsForUser(userId);
  const employed = await db
    .selectDistinct({ id: organizations.id, name: organizations.name })
    .from(employments)
    .innerJoin(organizations, eq(employments.organizationId, organizations.id))
    .where(and(eq(employments.userId, userId), isNull(employments.endedAt)));

  const entries = new Map<string, { name: string; role: DirectoryOrganizationRole }>();
  for (const organization of administered) {
    entries.set(organization.id, {
      name: organization.name,
      role: organization.ownerUserId === userId ? "OWNER" : "ORGANIZATION_ADMIN",
    });
  }
  for (const organization of employed) {
    if (!entries.has(organization.id)) {
      entries.set(organization.id, { name: organization.name, role: "MEMBER" });
    }
  }

  const result: DirectoryOrganization[] = [];
  for (const [organizationId, { name, role }] of entries) {
    const enabled = await isDirectoryOrganization(organizationId);
    result.push({
      organizationId,
      name,
      role,
      enabled,
      writable: await isDirectoryWritable(organizationId),
      newAgreementVersionReady:
        role === "OWNER" && (await readAgreement(organizationId, enabled)).newVersionReady,
    });
  }
  return result;
};

/** Counts for the support surface. Never a Profile field. */
export const directorySupportSummary = async (organizationId: string) => {
  const settings = await getDirectorySettings(organizationId);
  const enabled = settings?.enabled === true;
  const agreement = await readAgreement(organizationId, enabled);
  const [acceptances] = await db
    .select({ total: count() })
    .from(directoryAgreementAcceptances)
    .where(eq(directoryAgreementAcceptances.organizationId, organizationId));
  const [cells] = await db
    .select({ total: count() })
    .from(directoryPermissionCells)
    .where(eq(directoryPermissionCells.organizationId, organizationId));

  return {
    enabled,
    enabledAt: settings?.enabledAt ?? null,
    disabledAt: settings?.disabledAt ?? null,
    currentAgreementVersion: agreement.currentVersion,
    acceptedAgreementVersion: agreement.acceptedVersion,
    acceptedAt: agreement.acceptedAt,
    acceptances: acceptances?.total ?? 0,
    permissionCells: cells?.total ?? 0,
    people: await countDirectoryPeople(organizationId),
  };
};

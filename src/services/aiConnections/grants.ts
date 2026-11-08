import { and, desc, eq, inArray, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import {
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  user,
} from "../../db/schema/auth-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import AppError from "../../utils/appError.js";
import { FLEXIDAY_WRITE } from "../../utils/aiConnectionsOAuth.js";
import { personName } from "../person/personName.js";

type Executor = DbTransaction | typeof db;

export type GrantAccess = "read" | "write";

export type GrantApp = {
  clientId: string;
  name: string | null;
  /** A Client ID Metadata Document: its address was fetched, so `host` is checked. */
  verified: boolean;
  /** The `client_id` host when verified, the first redirect host otherwise. */
  host: string;
};

export type UserGrant = {
  grantId: string;
  app: GrantApp;
  organizationId: string;
  organizationName: string | null;
  access: GrantAccess;
  connectedAt: Date;
  lastUsedAt: Date;
};

export type OrganizationGrant = {
  grantId: string;
  app: GrantApp;
  userId: string;
  personName: string;
  access: GrantAccess;
};

const hostOf = (value: string | undefined): string => {
  if (!value) return "";
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
};

const appOf = (row: {
  clientId: string;
  name: string | null;
  discovery: string | null;
  redirectUris: string[];
}): GrantApp => {
  const verified = row.discovery === "cimd";
  return {
    clientId: row.clientId,
    name: row.name,
    verified,
    host: (verified ? hostOf(row.clientId) : "") || hostOf(row.redirectUris[0]),
  };
};

const accessOf = (scopes: string[]): GrantAccess =>
  scopes.includes(FLEXIDAY_WRITE) ? "write" : "read";

const hasWriteScope = (scopes: SQLWrapper) => sql`${scopes} @> ARRAY[${FLEXIDAY_WRITE}]::text[]`;

const appColumns = {
  clientId: oauthClient.clientId,
  name: oauthClient.name,
  discovery: oauthClient.clientDiscoveryId,
  redirectUris: oauthClient.redirectUris,
};

/**
 * The tokens of one grant: refresh tokens, and access tokens stored with
 * them, for the same user, client and organization.
 */
const sameGrant = (
  table: typeof oauthRefreshToken | typeof oauthAccessToken,
  grant: { userId: string; clientId: string; referenceId: string | null }
): SQL | undefined =>
  and(
    eq(table.userId, grant.userId),
    eq(table.clientId, grant.clientId),
    grant.referenceId === null
      ? sql`${table.referenceId} is null`
      : eq(table.referenceId, grant.referenceId)
  );

const deleteTokensOf = async (
  grants: { userId: string | null; clientId: string; referenceId: string | null }[],
  tx: Executor
) => {
  const owned = grants.flatMap((grant) =>
    grant.userId ? [{ ...grant, userId: grant.userId }] : []
  );
  if (owned.length === 0) return;
  await tx
    .delete(oauthRefreshToken)
    .where(or(...owned.map((grant) => sameGrant(oauthRefreshToken, grant))));
  await tx
    .delete(oauthAccessToken)
    .where(or(...owned.map((grant) => sameGrant(oauthAccessToken, grant))));
};

/** The caller's AI connections, newest first. */
export const listUserGrants = async (userId: string): Promise<UserGrant[]> => {
  const lastToken = sql<Date | null>`(
    select max(${oauthRefreshToken.createdAt}) from ${oauthRefreshToken}
    where ${oauthRefreshToken.userId} = ${oauthConsent.userId}
      and ${oauthRefreshToken.clientId} = ${oauthConsent.clientId}
      and ${oauthRefreshToken.referenceId} = ${oauthConsent.referenceId}
  )`.mapWith((value: string | Date | null) => (value === null ? null : new Date(value)));

  const rows = await db
    .select({
      grantId: oauthConsent.id,
      referenceId: oauthConsent.referenceId,
      scopes: oauthConsent.scopes,
      createdAt: oauthConsent.createdAt,
      updatedAt: oauthConsent.updatedAt,
      organizationName: organizations.name,
      lastToken,
      ...appColumns,
    })
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .leftJoin(organizations, eq(organizations.id, oauthConsent.referenceId))
    .where(eq(oauthConsent.userId, userId))
    .orderBy(desc(oauthConsent.createdAt), organizations.name, oauthClient.name, oauthConsent.id);

  return rows.flatMap((row) =>
    row.referenceId
      ? [
          {
            grantId: row.grantId,
            app: appOf(row),
            organizationId: row.referenceId,
            organizationName: row.organizationName,
            access: accessOf(row.scopes),
            connectedAt: row.createdAt,
            lastUsedAt:
              row.lastToken && row.lastToken > row.updatedAt ? row.lastToken : row.updatedAt,
          },
        ]
      : []
  );
};

/**
 * Ends one of the caller's grants: its consent and every refresh and access
 * token for the same user, client and organization, in one transaction.
 * Answers 404 for a grant that is not the caller's.
 */
export const disconnectGrant = async (args: { userId: string; grantId: string }) => {
  await db.transaction(async (tx) => {
    const [gone] = await tx
      .delete(oauthConsent)
      .where(and(eq(oauthConsent.id, args.grantId), eq(oauthConsent.userId, args.userId)))
      .returning({
        userId: oauthConsent.userId,
        clientId: oauthConsent.clientId,
        referenceId: oauthConsent.referenceId,
      });
    if (!gone) {
      throw new AppError({
        message: "AI connection not found",
        code: 404,
        context: { grantId: args.grantId },
      });
    }
    await deleteTokensOf([gone], tx);
  });
};

/**
 * Every grant the user holds, in every organization: password reset, password
 * change with sign-out of other sessions, account deletion.
 */
export const deleteUserGrants = async (userId: string, tx: Executor) => {
  await tx.delete(oauthConsent).where(eq(oauthConsent.userId, userId));
  await tx.delete(oauthRefreshToken).where(eq(oauthRefreshToken.userId, userId));
  await tx.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, userId));
};

/**
 * The organization's grants: every one when AI connections go off or the
 * organization is deleted, only those holding `flexiday.write` when it is
 * lowered to Read only. A write grant goes whole; its member connects again
 * with read access.
 */
export const deleteOrganizationGrants = async (
  args: { organizationIds: string[]; writeOnly?: boolean },
  tx: Executor
) => {
  if (args.organizationIds.length === 0) return;
  const inOrganizations = (table: typeof oauthConsent | typeof oauthRefreshToken) =>
    inArray(table.referenceId, args.organizationIds);

  if (!args.writeOnly) {
    await tx.delete(oauthConsent).where(inOrganizations(oauthConsent));
    await tx.delete(oauthRefreshToken).where(inOrganizations(oauthRefreshToken));
    await tx
      .delete(oauthAccessToken)
      .where(inArray(oauthAccessToken.referenceId, args.organizationIds));
    return;
  }

  const gone = await tx
    .delete(oauthConsent)
    .where(and(inOrganizations(oauthConsent), hasWriteScope(oauthConsent.scopes)))
    .returning({
      userId: oauthConsent.userId,
      clientId: oauthConsent.clientId,
      referenceId: oauthConsent.referenceId,
    });
  await deleteTokensOf(gone, tx);
  // A token carrying write whose consent was narrowed or is gone still goes.
  await tx
    .delete(oauthRefreshToken)
    .where(and(inOrganizations(oauthRefreshToken), hasWriteScope(oauthRefreshToken.scopes)));
  await tx
    .delete(oauthAccessToken)
    .where(
      and(
        inArray(oauthAccessToken.referenceId, args.organizationIds),
        hasWriteScope(oauthAccessToken.scopes)
      )
    );
};

/** The organization's grants, for the owner's lower and off dialogs: app, person, access. */
export const listOrganizationGrants = async (
  organizationId: string,
  tx?: DbTransaction
): Promise<OrganizationGrant[]> => {
  const rows = await (tx ?? db)
    .select({
      grantId: oauthConsent.id,
      userId: user.id,
      personName: personName(user, { organizationId }),
      scopes: oauthConsent.scopes,
      ...appColumns,
    })
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .innerJoin(user, eq(user.id, oauthConsent.userId))
    .where(eq(oauthConsent.referenceId, organizationId))
    .orderBy(oauthClient.name, oauthConsent.createdAt, oauthConsent.id);

  return rows.map((row) => ({
    grantId: row.grantId,
    app: appOf(row),
    userId: row.userId,
    personName: row.personName,
    access: accessOf(row.scopes),
  }));
};

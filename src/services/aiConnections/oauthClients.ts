import { and, eq, isNull, lt, notExists, sql } from "drizzle-orm";
import { db } from "../../db/db.js";
import {
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
} from "../../db/schema/auth-schema.js";

const PRUNE_AFTER = sql`interval '7 days'`;

/**
 * Deletes registered clients older than 7 days that hold no grant: no consent,
 * no refresh token, no access token. Clients found through a metadata document
 * (CIMD) are left alone; they are fetched again on demand. Runs on each
 * registration, so open registration can't pile up clients nobody used.
 */
export const pruneUnusedOAuthClients = async (): Promise<number> => {
  const deleted = await db
    .delete(oauthClient)
    .where(
      and(
        lt(oauthClient.createdAt, sql`now() - ${PRUNE_AFTER}`),
        isNull(oauthClient.clientDiscoveryId),
        notExists(
          db
            .select({ id: oauthConsent.id })
            .from(oauthConsent)
            .where(eq(oauthConsent.clientId, oauthClient.clientId))
        ),
        notExists(
          db
            .select({ id: oauthRefreshToken.id })
            .from(oauthRefreshToken)
            .where(eq(oauthRefreshToken.clientId, oauthClient.clientId))
        ),
        notExists(
          db
            .select({ id: oauthAccessToken.id })
            .from(oauthAccessToken)
            .where(eq(oauthAccessToken.clientId, oauthClient.clientId))
        )
      )
    )
    .returning({ clientId: oauthClient.clientId });
  return deleted.length;
};

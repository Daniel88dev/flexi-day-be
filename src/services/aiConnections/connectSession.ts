import { eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { session as sessionTable } from "../../db/schema/auth-schema.js";

/**
 * The connect picker's choice, kept on the session the OAuth flow runs in,
 * where `postLogin.consentReferenceId` reads it.
 */
export const rememberConnectOrganization = async (
  sessionId: string,
  organizationId: string
): Promise<void> => {
  await db
    .update(sessionTable)
    .set({ oauthOrganizationId: organizationId })
    .where(eq(sessionTable.id, sessionId));
};

/** Forgets the choice, so a fresh authorization has to pick again. */
export const forgetConnectOrganization = async (sessionId: string): Promise<void> => {
  await db
    .update(sessionTable)
    .set({ oauthOrganizationId: null })
    .where(eq(sessionTable.id, sessionId));
};

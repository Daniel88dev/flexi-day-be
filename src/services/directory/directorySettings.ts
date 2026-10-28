import { eq } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { organizationDirectorySettings } from "../../db/schema/directory-schema.js";

// Imports no service: the employment service reads the toggle, and importing
// the settings service from there closed a cycle through the organization one.

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

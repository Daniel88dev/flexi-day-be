import { and, asc, eq, isNotNull, ne } from "drizzle-orm";
import { db } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { user } from "../../db/schema/auth-schema.js";
import { getPersonContacts } from "../person/personName.js";
import type { OwnedOrganizationGoing } from "./types.js";

/**
 * The organizations that go with the caller's account, each with the Deleted
 * accounts whose Employments go with it, under the names the organization
 * kept. The delete dialog lists them beside the link to the Organization
 * export.
 */
export const getOwnedOrganizationsGoing = async (
  userId: string
): Promise<OwnedOrganizationGoing[]> => {
  const owned = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.ownerUserId, userId))
    .orderBy(asc(organizations.name), asc(organizations.id));

  const result: OwnedOrganizationGoing[] = [];
  for (const organization of owned) {
    const rows = await db
      .selectDistinct({ userId: user.id })
      .from(employments)
      .innerJoin(user, eq(user.id, employments.userId))
      .where(
        and(
          eq(employments.organizationId, organization.id),
          isNotNull(employments.accountDeletedAt),
          ne(employments.userId, userId)
        )
      );
    const contacts = await getPersonContacts(
      rows.map((row) => row.userId),
      { organizationId: organization.id }
    );
    result.push({
      organizationId: organization.id,
      organizationName: organization.name,
      deletedAccounts: contacts
        .map((contact) => ({ userId: contact.id, name: contact.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  return result;
};

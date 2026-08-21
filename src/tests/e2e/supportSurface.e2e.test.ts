/**
 * Lock-down tests for the platform-support read surface's data invariants
 * (see CLAUDE.md "Platform-Support Surface"). Runs against a real database.
 * Test library/framework: Vitest
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { supportAccess } from "../../db/schema/support-access-schema.js";
import {
  getGroupDetailForSupport,
  recordSupportAccess,
  searchOrganizationsForSupport,
} from "../../services/support/supportServices.js";
import { cleanupTestData } from "./helpers/testSetup.js";

describe("support surface data invariants", () => {
  const ownerId = uuidv4();
  const orgId = uuidv4();
  const groupId = uuidv4();

  beforeAll(async () => {
    await cleanupTestData();
    await db.insert(user).values({
      id: ownerId,
      email: `support-owner-${ownerId}@dev.local`,
      name: "Support Owner a_b",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(organizations).values({
      id: orgId,
      name: "Support Org a_b",
      ownerUserId: ownerId,
      billingEmail: `support-owner-${ownerId}@dev.local`,
    });
    await db.insert(groups).values({
      id: groupId,
      organizationId: orgId,
      groupName: "Support Group",
      managerUserId: ownerId,
    });
    await db.insert(vacation).values({
      id: uuidv4(),
      userId: ownerId,
      groupId,
      requestedDay: "2026-08-03",
      note: "medical appointment",
      rejectedAt: new Date(),
      rejectedBy: ownerId,
      rejectionReason: "private reason",
    });
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("group detail never carries note or rejectionReason", async () => {
    const detail = await getGroupDetailForSupport(groupId);
    expect(detail).toBeDefined();
    expect(detail!.vacations).toHaveLength(1);
    const row = detail!.vacations[0] as unknown as Record<string, unknown>;
    expect(row).not.toHaveProperty("note");
    expect(row).not.toHaveProperty("rejectionReason");
    // The state timestamps themselves must survive — they are the point.
    expect(row.rejectedAt).toBeTruthy();
  });

  it("escapes ILIKE wildcards in the search term", async () => {
    const underscore = await searchOrganizationsForSupport("a_b");
    expect(underscore.map((o) => o.id)).toContain(orgId);

    // "_" is escaped, so it must not act as a single-character wildcard —
    // unescaped, "S_pport" would match "Support Org a_b".
    const wildcardAbuse = await searchOrganizationsForSupport("S_pport");
    expect(wildcardAbuse.map((o) => o.id)).not.toContain(orgId);

    // A bare "%" must not turn into match-everything.
    const percent = await searchOrganizationsForSupport("%");
    expect(percent).toHaveLength(0);
  });

  it("audit rows block deleting the audited user instead of vanishing with it", async () => {
    await recordSupportAccess({
      userId: ownerId,
      method: "GET",
      path: "/api/support/organizations",
    });

    await expect(db.delete(user).where(eq(user.id, ownerId))).rejects.toThrow();

    const rows = await db.select().from(supportAccess).where(eq(supportAccess.userId, ownerId));
    expect(rows).toHaveLength(1);
  });
});

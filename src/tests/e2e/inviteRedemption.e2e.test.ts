import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v4 as uuidv4 } from "uuid";
import type { Request, Response } from "express";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { inviteLink } from "../../db/schema/invite-link-schema.js";
import { eq } from "drizzle-orm";
import { createTestUser, cleanupTestData } from "./helpers/testSetup.js";
import { handlePostGroupUser } from "../../controllers/groupUser/handlePostGroupUser.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { generateInviteCode } from "../../utils/inviteCode.js";

/**
 * An email-bound invite is only as strong as the address on the session that
 * redeems it. Social sign-in can produce a session whose address the provider
 * never vouched for — Microsoft Entra lets a tenant admin set `mail` freely —
 * so redemption must require a verified address. Runs against a real database.
 */
describe("invite redemption email binding", () => {
  let owner: { id: string; email: string };
  let groupId: string;

  const redeem = async (
    code: string,
    session: { userId: string; userEmail: string; emailVerified: boolean }
  ) => {
    const req = {
      url: `/api/group-user/${code}`,
      params: { validationCode: code },
      auth: {
        sessionId: uuidv4(),
        userName: "Redeemer",
        ...session,
      },
    } as unknown as Request;

    const res = {
      status() {
        return this;
      },
      json() {
        return this;
      },
    } as unknown as Response;

    return handlePostGroupUser(req, res);
  };

  const issueInvite = async (email: string | null) => {
    // Must be a real code: the handler runs it through normalizeInviteCode
    // before touching the database.
    const code = generateInviteCode();
    await db.insert(inviteLink).values({
      id: uuidv4(),
      groupId,
      code,
      email,
      invitedByUserId: owner.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    return code;
  };

  beforeAll(async () => {
    await cleanupTestData();
    owner = await createTestUser("invite-owner@test.com", "Invite Owner", "password123");
    const organization = await ensureOrganizationForUser(owner.id);

    groupId = uuidv4();
    await db.insert(groups).values({
      id: groupId,
      organizationId: organization.id,
      groupName: "Invite Target",
      managerUserId: owner.id,
      defaultVacationDays: 20,
      defaultHomeOfficeDays: 5,
    });
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("refuses an email-bound invite when the session address is unverified", async () => {
    const invited = await createTestUser("hijack-target@test.com", "Target", "password123");
    const code = await issueInvite(invited.email);

    // The exact shape of an Entra sign-in whose tenant never proved it owns the
    // domain: the address matches the invite, but nobody vouched for it.
    await expect(
      redeem(code, { userId: invited.id, userEmail: invited.email, emailVerified: false })
    ).rejects.toMatchObject({ code: 403 });

    const members = await db.select().from(groupUsers).where(eq(groupUsers.groupId, groupId));
    expect(members).toHaveLength(0);
  });

  it("admits the invited address once it is verified", async () => {
    const invited = await createTestUser("verified-joiner@test.com", "Joiner", "password123");
    const code = await issueInvite(invited.email);

    await expect(
      redeem(code, { userId: invited.id, userEmail: invited.email, emailVerified: true })
    ).resolves.toBeDefined();

    const members = await db.select().from(groupUsers).where(eq(groupUsers.userId, invited.id));
    expect(members).toHaveLength(1);
  });

  it("still refuses a verified session whose address differs from the invite", async () => {
    const stranger = await createTestUser("stranger@test.com", "Stranger", "password123");
    const code = await issueInvite("someone-else@test.com");

    await expect(
      redeem(code, { userId: stranger.id, userEmail: stranger.email, emailVerified: true })
    ).rejects.toMatchObject({ code: 403 });
  });

  it("leaves pre-email invites (null email) unrestricted", async () => {
    const legacy = await createTestUser("legacy-joiner@test.com", "Legacy", "password123");
    const code = await issueInvite(null);

    await expect(
      redeem(code, { userId: legacy.id, userEmail: legacy.email, emailVerified: false })
    ).resolves.toBeDefined();
  });
});

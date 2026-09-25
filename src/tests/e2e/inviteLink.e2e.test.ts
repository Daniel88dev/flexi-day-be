import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { inviteLink } from "../../db/schema/invite-link-schema.js";
import { manualPlanOverride } from "../../db/schema/subscription-schema.js";
import { config } from "../../config.js";
import { createServer } from "../../server.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { generateInviteCode } from "../../utils/inviteCode.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { cleanupTestData, createTestGroup, createTestUser } from "./helpers/testSetup.js";

type SentEmail = { to: string; template: string; data: Record<string, string> };
const sentEmails: SentEmail[] = [];
vi.mock("../../services/email/index.js", () => ({
  emailSender: {
    sendTemplated: (email: SentEmail) => {
      sentEmails.push(email);
      return Promise.resolve();
    },
  },
}));

/**
 * The invite link: the secret only the invited mailbox receives. Following it
 * proves the mailbox, so redeeming it also verifies the address. Driven over
 * HTTP against a real database.
 */
describe("invite link", () => {
  let app: Express;
  let owner: { id: string; name: string };
  let ownerCookie: string;
  let groupId: string;

  const makeUser = async (emailVerified: boolean) => {
    const id = uuidv4();
    const email = `invitee-${id}@invite-link.test`;
    await db.insert(user).values({
      id,
      email,
      name: "Invitee",
      emailVerified,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { id, email, cookie: await authCookieFor(id) };
  };

  const issueInvite = async (email: string, forGroup = groupId, cookie = ownerCookie) => {
    const sentBefore = sentEmails.length;
    const res = await request(app)
      .post(`/api/group-user/${forGroup}/invites`)
      .set("Cookie", cookie)
      .send({ email });
    expect(res.status).toBe(201);
    const mail = sentEmails.slice(sentBefore).find((m) => m.template === "group-invite");
    if (!mail) throw new Error("no invite email was sent");
    const token = new URL(mail.data.inviteUrl!).searchParams.get("token");
    if (!token) throw new Error("the invite URL carries no token");
    return { res, mail, token, code: (res.body as { invite: { code: string } }).invite.code };
  };

  const preview = (token: string) => request(app).post("/api/auth/invite/preview").send({ token });

  const join = (token: string, cookie: string) =>
    request(app).post("/api/auth/invite/join").set("Cookie", cookie).send({ token });

  const redeemCode = (code: string, cookie: string) =>
    request(app).post(`/api/group-user/code/${code}`).set("Cookie", cookie);

  const isVerified = async (cookie: string) => {
    const res = await request(app).get("/api/auth/get-session").set("Cookie", cookie);
    return (res.body as { user: { emailVerified: boolean } }).user.emailVerified;
  };

  const groupIdsOf = async (cookie: string) => {
    const res = await request(app).get("/api/group").set("Cookie", cookie);
    return (res.body as { id: string }[]).map((g) => g.id);
  };

  const errorCode = (res: request.Response) =>
    (res.body as { errors: { context?: { code?: string } }[] }).errors[0]?.context?.code;

  beforeAll(async () => {
    await cleanupTestData();
    app = createServer();
    const created = await createTestUser("link-owner@test.com", "Link Owner", "password123");
    owner = { id: created.id, name: created.name };
    ownerCookie = await authCookieFor(owner.id);
    groupId = (await createTestGroup("Link Target", owner.id)).id;
    // Every test leaves an invite or a member behind in this one group, which
    // would run a Free plan's ten seats out partway through the file.
    await upsertSubscription((await ensureOrganizationForUser(owner.id)).id, {
      manualPlanOverride: manualPlanOverride.Custom,
      manualMaxGroups: 10,
      manualMaxMembersPerGroup: 100,
    });
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  describe("issuing", () => {
    it("mails an invite URL alongside the existing fields", async () => {
      const invitee = await makeUser(false);
      const { mail, token, code } = await issueInvite(invitee.email);

      expect(mail.to).toBe(invitee.email);
      expect(mail.data.inviteUrl).toBe(
        new URL(`/join/?token=${token}`, config.email.appUrl).toString()
      );
      expect(mail.data.inviteCode).toBe(code);
      expect(mail.data.signUpUrl).toBeTruthy();
      expect(mail.data.joinUrl).toBeTruthy();
      expect(token.length).toBeGreaterThanOrEqual(43);
    });

    it("hands the secret to no admin-facing response and stores only its hash", async () => {
      const invitee = await makeUser(true);
      const { res, token } = await issueInvite(invitee.email);
      const [row] = await db
        .select()
        .from(inviteLink)
        .where(eq(inviteLink.id, (res.body as { invite: { id: string } }).invite.id));
      if (!row) throw new Error("the invite row is missing");

      expect(Object.values(row)).not.toContain(token);
      expect(row.linkSecretHash).toBeTruthy();

      const listed = await request(app)
        .get(`/api/group-user/${groupId}/invites`)
        .set("Cookie", ownerCookie);
      const revoked = await request(app)
        .delete(`/api/group-user/invites/${row.id}`)
        .set("Cookie", ownerCookie);

      for (const body of [res.text, listed.text, revoked.text]) {
        expect(body).not.toContain(token);
        expect(body).not.toContain(row.linkSecretHash);
        expect(body).not.toContain("linkSecretHash");
      }
    });
  });

  describe("preview", () => {
    it("describes an open invite without consuming it", async () => {
      const invitee = await makeUser(false);
      const { token } = await issueInvite(invitee.email);

      for (let i = 0; i < 2; i++) {
        const res = await preview(token);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          groupId,
          groupName: "Link Target",
          inviterName: owner.name,
          invitedEmail: invitee.email,
          status: "open",
        });
      }

      expect((await join(token, invitee.cookie)).status).toBe(201);
    });

    it("reports a used invite", async () => {
      const invitee = await makeUser(true);
      const { token } = await issueInvite(invitee.email);
      await join(token, invitee.cookie);

      expect((await preview(token)).body).toMatchObject({ status: "used" });
    });

    it("reports a revoked invite", async () => {
      const invitee = await makeUser(true);
      const { res, token } = await issueInvite(invitee.email);
      await request(app)
        .delete(`/api/group-user/invites/${(res.body as { invite: { id: string } }).invite.id}`)
        .set("Cookie", ownerCookie);

      expect((await preview(token)).body).toMatchObject({ status: "revoked" });
    });

    it("reports an expired invite", async () => {
      const invitee = await makeUser(true);
      const { res, token } = await issueInvite(invitee.email);
      await db
        .update(inviteLink)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(inviteLink.id, (res.body as { invite: { id: string } }).invite.id));

      expect((await preview(token)).body).toMatchObject({ status: "expired" });
    });

    it("answers not found for a token nobody issued", async () => {
      const res = await preview("x".repeat(43));
      expect(res.status).toBe(404);
      expect(errorCode(res)).toBe("INVITE_NOT_FOUND");
    });
  });

  describe("redeeming", () => {
    it("joins an unverified invitee and verifies the address", async () => {
      const invitee = await makeUser(false);
      const { token } = await issueInvite(invitee.email);

      const res = await join(token, invitee.cookie);

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ groupId });
      expect(await groupIdsOf(invitee.cookie)).toContain(groupId);
      expect(await isVerified(invitee.cookie)).toBe(true);
    });

    it("joins an invitee whose address was already verified", async () => {
      const invitee = await makeUser(true);
      const { token } = await issueInvite(invitee.email);

      expect((await join(token, invitee.cookie)).status).toBe(201);
      expect(await groupIdsOf(invitee.cookie)).toContain(groupId);
      expect(await isVerified(invitee.cookie)).toBe(true);
    });

    it("refuses a session with a different address and changes nothing", async () => {
      const invitee = await makeUser(false);
      const stranger = await makeUser(false);
      const { token } = await issueInvite(invitee.email);

      const res = await join(token, stranger.cookie);

      expect(res.status).toBe(403);
      expect(errorCode(res)).toBe("INVITE_EMAIL_MISMATCH");
      expect(await groupIdsOf(stranger.cookie)).not.toContain(groupId);
      expect(await isVerified(stranger.cookie)).toBe(false);
      expect((await preview(token)).body).toMatchObject({ status: "open" });
    });

    it("requires a session", async () => {
      const invitee = await makeUser(false);
      const { token } = await issueInvite(invitee.email);

      expect((await request(app).post("/api/auth/invite/join").send({ token })).status).toBe(401);
    });

    it("uses up the invite, so neither the link nor the code works again", async () => {
      const invitee = await makeUser(false);
      const { token, code } = await issueInvite(invitee.email);
      await join(token, invitee.cookie);

      const again = await join(token, invitee.cookie);
      expect(again.status).toBe(410);
      expect(errorCode(again)).toBe("INVITE_USED");
      expect((await redeemCode(code, invitee.cookie)).status).toBe(404);
    });

    it("stops the link working once the code was redeemed", async () => {
      const invitee = await makeUser(true);
      const { token, code } = await issueInvite(invitee.email);

      expect((await redeemCode(code, invitee.cookie)).status).toBe(201);

      const res = await join(token, invitee.cookie);
      expect(res.status).toBe(410);
      expect(errorCode(res)).toBe("INVITE_USED");
    });

    it("revokes the old link when the address is invited again", async () => {
      const invitee = await makeUser(false);
      const first = await issueInvite(invitee.email);
      const second = await issueInvite(invitee.email);

      const stale = await join(first.token, invitee.cookie);
      expect(stale.status).toBe(410);
      expect(errorCode(stale)).toBe("INVITE_REVOKED");
      expect((await join(second.token, invitee.cookie)).status).toBe(201);
    });

    it("refuses an expired invite", async () => {
      const invitee = await makeUser(false);
      const { res, token } = await issueInvite(invitee.email);
      await db
        .update(inviteLink)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(inviteLink.id, (res.body as { invite: { id: string } }).invite.id));

      const joined = await join(token, invitee.cookie);
      expect(joined.status).toBe(410);
      expect(errorCode(joined)).toBe("INVITE_EXPIRED");
      expect(await isVerified(invitee.cookie)).toBe(false);
    });

    it("tells a member they already belong to the group", async () => {
      const invitee = await makeUser(true);
      const { token } = await issueInvite(invitee.email);
      await db.insert(groupUsers).values({
        id: uuidv4(),
        userId: invitee.id,
        groupId,
        viewAccess: true,
        controlledUser: true,
      });

      const res = await join(token, invitee.cookie);
      expect(res.status).toBe(409);
      expect(errorCode(res)).toBe("ALREADY_MEMBER");
    });

    it("holds to the group's seat cap", async () => {
      const cappedOwner = await createTestUser("capped-owner@test.com", "Capped", "password123");
      const cappedCookie = await authCookieFor(cappedOwner.id);
      const organization = await ensureOrganizationForUser(cappedOwner.id);
      await upsertSubscription(organization.id, {
        manualPlanOverride: manualPlanOverride.Custom,
        manualMaxGroups: 10,
        manualMaxMembersPerGroup: 1,
      });
      const cappedGroupId = (await createTestGroup("Capped", cappedOwner.id)).id;

      const invitee = await makeUser(false);
      const { token } = await issueInvite(invitee.email, cappedGroupId, cappedCookie);
      const occupant = await makeUser(true);
      await db.insert(groupUsers).values({
        id: uuidv4(),
        userId: occupant.id,
        groupId: cappedGroupId,
        viewAccess: true,
        controlledUser: true,
      });

      const res = await join(token, invitee.cookie);

      expect(res.status).toBe(402);
      expect(await groupIdsOf(invitee.cookie)).not.toContain(cappedGroupId);
      expect(await isVerified(invitee.cookie)).toBe(false);
      expect((await preview(token)).body).toMatchObject({ status: "open" });
    });

    it("still redeems a legacy invite that has no link by its code", async () => {
      const invitee = await makeUser(true);
      const code = generateInviteCode();
      await db.insert(inviteLink).values({
        id: uuidv4(),
        groupId,
        code,
        email: invitee.email,
        invitedByUserId: owner.id,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      expect((await redeemCode(code, invitee.cookie)).status).toBe(201);
      expect(await groupIdsOf(invitee.cookie)).toContain(groupId);
    });

    it("still refuses a bare code from an unverified address", async () => {
      const invitee = await makeUser(false);
      const { code } = await issueInvite(invitee.email);

      expect((await redeemCode(code, invitee.cookie)).status).toBe(403);
    });
  });
});

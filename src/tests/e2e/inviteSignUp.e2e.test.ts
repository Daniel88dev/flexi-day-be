import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createHash } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { inviteLink } from "../../db/schema/invite-link-schema.js";
import { manualPlanOverride } from "../../db/schema/subscription-schema.js";
import { createServer } from "../../server.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
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

const PASSWORD = "sturdy-passphrase-42";

// Sign-up runs the Have I Been Pwned check, an outbound call. Answered here so
// the suite runs offline and a breached password can be staged.
const breachedPasswords = new Set<string>();
const sha1 = (value: string) => createHash("sha1").update(value).digest("hex").toUpperCase();
const realFetch = globalThis.fetch;
vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  if (!url.startsWith("https://api.pwnedpasswords.com/range/")) return realFetch(input, init);
  const prefix = url.slice(-5);
  const body = [...breachedPasswords]
    .map(sha1)
    .filter((hash) => hash.startsWith(prefix))
    .map((hash) => `${hash.slice(5)}:1234`)
    .join("\r\n");
  return Promise.resolve(
    new Response(body, { status: 200, headers: { "content-type": "text/plain" } })
  );
});

/**
 * Sign up with invite: a new invitee creates their account from the invite
 * link and is verified, signed in and in the group at once. Holding the link
 * secret is the proof of the mailbox, so no confirmation email goes out.
 * Driven over HTTP against a real database.
 */
describe("sign up with invite", () => {
  let app: Express;
  let ownerCookie: string;
  let groupId: string;

  const freshEmail = () => `newcomer-${uuidv4()}@invite-signup.test`;

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
    const invite = (res.body as { invite: { id: string; code: string } }).invite;
    return { token, code: invite.code, inviteId: invite.id };
  };

  const signUp = (body: { name?: string; email: string; password?: string; token: string }) =>
    request(app)
      .post("/api/auth/invite/sign-up")
      .send({ name: "Nora Newcomer", password: PASSWORD, ...body });

  const sessionCookieOf = (res: request.Response) => {
    const setCookie = res.headers["set-cookie"] as unknown as string[] | undefined;
    return (setCookie ?? []).map((value) => value.split(";")[0]).join("; ");
  };

  const sessionOf = async (cookie: string) => {
    const res = await request(app).get("/api/auth/get-session").set("Cookie", cookie);
    return res.body as { user: { email: string; emailVerified: boolean } } | null;
  };

  const groupIdsOf = async (cookie: string) => {
    const res = await request(app).get("/api/group").set("Cookie", cookie);
    return (res.body as { id: string }[]).map((g) => g.id);
  };

  const preview = (token: string) => request(app).post("/api/auth/invite/preview").send({ token });

  // A password sign-in tells the three account states apart without reading
  // a table: 401 for no account, 403 for an unconfirmed one, 200 otherwise.
  const signInStatus = async (email: string, password = PASSWORD) =>
    (await request(app).post("/api/auth/sign-in/email").send({ email, password })).status;

  const errorCode = (res: request.Response) =>
    (res.body as { errors: { context?: { code?: string } }[] }).errors[0]?.context?.code;

  const mailTo = (email: string) => sentEmails.filter((m) => m.to === email);

  beforeAll(async () => {
    await cleanupTestData();
    app = createServer();
    const owner = await createTestUser("signup-owner@test.com", "Signup Owner", "password123");
    ownerCookie = await authCookieFor(owner.id);
    groupId = (await createTestGroup("Signup Target", owner.id)).id;
    await upsertSubscription((await ensureOrganizationForUser(owner.id)).id, {
      manualPlanOverride: manualPlanOverride.Custom,
      manualMaxGroups: 10,
      manualMaxMembersPerGroup: 100,
    });
  });

  beforeEach(() => {
    breachedPasswords.clear();
  });

  afterAll(async () => {
    await cleanupTestData();
    vi.restoreAllMocks();
  });

  it("creates a verified account, signs it in and joins the group, with no confirmation email", async () => {
    const email = freshEmail();
    const { token } = await issueInvite(email);

    const res = await signUp({ email, token });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ membership: { groupId } });
    const cookie = sessionCookieOf(res);
    const session = await sessionOf(cookie);
    expect(session?.user).toMatchObject({ email, emailVerified: true });
    expect(await groupIdsOf(cookie)).toContain(groupId);
    expect(mailTo(email).map((m) => m.template)).toEqual(["group-invite"]);
    expect(await signInStatus(email)).toBe(200);
  });

  it("accepts the invited address typed in another letter case", async () => {
    const email = freshEmail();
    const { token } = await issueInvite(email);

    const res = await signUp({ email: email.toUpperCase(), token });

    expect(res.status).toBe(201);
    expect((await sessionOf(sessionCookieOf(res)))?.user.email).toBe(email);
  });

  it("uses up the invite, so neither its link nor its code works again", async () => {
    const email = freshEmail();
    const { token, code } = await issueInvite(email);
    const res = await signUp({ email, token });
    const cookie = sessionCookieOf(res);

    expect((await preview(token)).body).toMatchObject({ status: "used" });
    const byLink = await request(app)
      .post("/api/auth/invite/join")
      .set("Cookie", cookie)
      .send({ token });
    expect(byLink.status).toBe(410);
    expect(errorCode(byLink)).toBe("INVITE_USED");
    const byCode = await request(app).post(`/api/group-user/code/${code}`).set("Cookie", cookie);
    expect(byCode.status).toBe(404);
  });

  it("refuses an address other than the invited one and creates nothing", async () => {
    const invited = freshEmail();
    const other = freshEmail();
    const { token } = await issueInvite(invited);

    const res = await signUp({ email: other, token });

    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe("INVITE_EMAIL_MISMATCH");
    expect(await signInStatus(other)).toBe(401);
    expect((await preview(token)).body).toMatchObject({ status: "open" });
  });

  describe("an invite that can no longer be used", () => {
    const close = {
      used: async (inviteId: string) =>
        db.update(inviteLink).set({ usedAt: new Date() }).where(eq(inviteLink.id, inviteId)),
      expired: async (inviteId: string) =>
        db
          .update(inviteLink)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(inviteLink.id, inviteId)),
      revoked: async (inviteId: string) =>
        request(app).delete(`/api/group-user/invites/${inviteId}`).set("Cookie", ownerCookie),
    };

    it.each(["used", "expired", "revoked"] as const)(
      "refuses a %s invite and creates no account",
      async (status) => {
        const email = freshEmail();
        const { token, inviteId } = await issueInvite(email);
        await close[status](inviteId);

        const res = await signUp({ email, token });

        expect(res.status).toBe(410);
        expect(errorCode(res)).toBe(`INVITE_${status.toUpperCase()}`);
        expect(await signInStatus(email)).toBe(401);
      }
    );
  });

  it("answers not found for a token nobody issued", async () => {
    const res = await signUp({ email: freshEmail(), token: "x".repeat(43) });

    expect(res.status).toBe(404);
    expect(errorCode(res)).toBe("INVITE_NOT_FOUND");
  });

  it("refuses an address that already has an account and leaves both alone", async () => {
    const email = freshEmail();
    const id = uuidv4();
    await db.insert(user).values({
      id,
      email,
      name: "Earlier Sign-up",
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { token } = await issueInvite(email);

    const res = await signUp({ email, token });

    expect(res.status).toBe(422);
    expect(errorCode(res)).toBe("USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL");
    expect(sessionCookieOf(res)).toBe("");
    expect((await sessionOf(await authCookieFor(id)))?.user.emailVerified).toBe(false);
    expect((await preview(token)).body).toMatchObject({ status: "open" });
  });

  it("applies the breached-password check of a normal sign-up", async () => {
    const email = freshEmail();
    const { token } = await issueInvite(email);
    breachedPasswords.add(PASSWORD);

    const res = await signUp({ email, token });

    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("PASSWORD_COMPROMISED");
    expect(await signInStatus(email)).toBe(401);
    expect((await preview(token)).body).toMatchObject({ status: "open" });
  });

  it("applies the password length policy of a normal sign-up", async () => {
    const email = freshEmail();
    const { token } = await issueInvite(email);

    const res = await signUp({ email, token, password: "short" });

    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("PASSWORD_TOO_SHORT");
    expect(await signInStatus(email)).toBe(401);
  });

  it("holds to the group's seat cap without leaving an account behind", async () => {
    const cappedOwner = await createTestUser("signup-capped@test.com", "Capped", "password123");
    const cappedCookie = await authCookieFor(cappedOwner.id);
    await upsertSubscription((await ensureOrganizationForUser(cappedOwner.id)).id, {
      manualPlanOverride: manualPlanOverride.Custom,
      manualMaxGroups: 10,
      manualMaxMembersPerGroup: 1,
    });
    const cappedGroupId = (await createTestGroup("Signup Capped", cappedOwner.id)).id;
    const email = freshEmail();
    const { token } = await issueInvite(email, cappedGroupId, cappedCookie);
    const occupantId = uuidv4();
    await db.insert(user).values({
      id: occupantId,
      email: freshEmail(),
      name: "Occupant",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(groupUsers).values({
      id: uuidv4(),
      userId: occupantId,
      groupId: cappedGroupId,
      viewAccess: true,
      controlledUser: true,
    });

    const res = await signUp({ email, token });

    expect(res.status).toBe(402);
    expect(await signInStatus(email)).toBe(401);
    expect((await preview(token)).body).toMatchObject({ status: "open" });
  });

  it("lets only one of two concurrent sign-ups on one invite through", async () => {
    const email = freshEmail();
    const { token } = await issueInvite(email);

    const results = await Promise.all([signUp({ email, token }), signUp({ email, token })]);
    const statuses = results.map((r) => r.status).sort((a, b) => a - b);

    expect(statuses[0]).toBe(201);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);
    expect(statuses[1]).toBeLessThan(500);
    const winner = results.find((r) => r.status === 201)!;
    expect(await groupIdsOf(sessionCookieOf(winner))).toContain(groupId);
    expect(await signInStatus(email)).toBe(200);
    expect(mailTo(email).map((m) => m.template)).toEqual(["group-invite"]);
  });
});

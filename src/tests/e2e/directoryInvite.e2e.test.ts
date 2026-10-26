import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { and, eq, isNull } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";
import { inviteLink } from "../../db/schema/invite-link-schema.js";
import { directoryProfileHistory } from "../../db/schema/directory-profile-schema.js";
import { user } from "../../db/schema/auth-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import {
  disableDirectory,
  enableDirectory,
} from "../../services/directory/directorySettingsServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { addMember, makeGroup, makeUser, resetReportData } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

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
// the suite runs offline.
const realFetch = globalThis.fetch;
vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  if (!url.startsWith("https://api.pwnedpasswords.com/range/")) return realFetch(input, init);
  return Promise.resolve(
    new Response("", { status: 200, headers: { "content-type": "text/plain" } })
  );
});

/**
 * The directory invite and the Claim: an admin invites a person without an
 * account, and redeeming any invite whose address matches binds the account to
 * that Employment. Driven over HTTP against a real database.
 */
describe("directory invite and claim", () => {
  let server: LoopbackServer;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    sentEmails.length = 0;
    await resetReportData();
    await cleanupTestData();
  });

  afterAll(async () => {
    await server?.close();
    await resetReportData();
    await cleanupTestData();
  });

  /**
   * Olga owns an Enterprise organization "Acme" with the directory on and
   * manages Support, where Bob is a plain member and Gabi a member with admin
   * access. Dana is a delegated org admin, Hana holds HR.
   */
  const setUp = async () => {
    const owner = await makeUser("Olga Owner");
    const bob = await makeUser("Bob Plain");
    const gabi = await makeUser("Gabi Admin");
    const dana = await makeUser("Dana Delegate");
    const hana = await makeUser("Hana Hr");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;

    const support = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    await addMember(support, bob.id);
    await addMember(support, gabi.id, { adminAccess: true });
    await addMember(support, hana.id);
    await db.insert(organizationUsers).values({
      id: generateRandomUUID(),
      organizationId,
      userId: dana.id,
      grantedByUserId: owner.id,
    });
    for (const person of [owner, bob, gabi, dana, hana]) {
      await syncEmployment(organizationId, person.id);
    }

    await upsertSubscription(organizationId, {
      plan: subscriptionPlan.Enterprise,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });
    await db.transaction((tx) =>
      enableDirectory({ organizationId, userId: owner.id, agreementVersion: 1 }, tx)
    );

    const world = { organizationId, support, users: { owner, bob, gabi, dana, hana } };
    const hr = await (
      await as(owner.id)
    ).put(
      `/api/directory/${organizationId}/roles/${await employmentIdOf(organizationId, hana.id)}`,
      {
        roles: ["HR"],
      }
    );
    expect(hr.status).toBe(200);
    return world;
  };

  type World = Awaited<ReturnType<typeof setUp>>;

  async function as(userId: string) {
    const cookie = await authCookieFor(userId);
    return {
      get: (path: string) => request(server.url).get(path).set("Cookie", cookie),
      post: (path: string, body: object) =>
        request(server.url).post(path).set("Cookie", cookie).send(body),
      put: (path: string, body: object) =>
        request(server.url).put(path).set("Cookie", cookie).send(body),
      patch: (path: string, body: object) =>
        request(server.url).patch(path).set("Cookie", cookie).send(body),
    };
  }

  const code = (res: request.Response) => res.body.errors?.[0]?.context?.code;

  async function employmentIdOf(organizationId: string, userId: string) {
    const [row] = await db
      .select({ id: employments.id })
      .from(employments)
      .where(
        and(
          eq(employments.organizationId, organizationId),
          eq(employments.userId, userId),
          isNull(employments.endedAt)
        )
      );
    return row!.id;
  }

  const addPerson = async (world: World, body: { name: string; email?: string }) => {
    const res = await (
      await as(world.users.owner.id)
    ).post(`/api/directory/${world.organizationId}/people`, body);
    expect(res.status).toBe(201);
    return res.body.employmentId as string;
  };

  const sendInvite = async (
    world: World,
    employmentId: string,
    callerId = world.users.owner.id,
    body: object = {}
  ) =>
    (await as(callerId)).post(
      `/api/directory/${world.organizationId}/people/${employmentId}/invite`,
      body
    );

  const tokenOf = (mail: SentEmail | undefined) => {
    if (!mail) throw new Error("no invite email was sent");
    const token = new URL(mail.data.inviteUrl!).searchParams.get("token");
    if (!token) throw new Error("the invite URL carries no token");
    return token;
  };

  describe("POST /api/directory/{organizationId}/people/{employmentId}/invite", () => {
    it("invites a person without an account to the organization and emails the link", async () => {
      const world = await setUp();
      const petra = await addPerson(world, { name: "Petra Nová", email: "Petra@Example.test" });

      const res = await sendInvite(world, petra);

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        emailDelivered: true,
        invite: { email: "petra@example.test", groupId: null, status: "open" },
      });
      expect(sentEmails).toHaveLength(1);
      const mail = sentEmails[0]!;
      expect(mail).toMatchObject({
        to: "petra@example.test",
        template: "directory-invite",
        data: {
          organizationName: expect.any(String),
          inviterName: "Olga Owner",
          personName: "Petra Nová",
          invitedEmail: "petra@example.test",
          expiresIn: "14 days",
          expiresInCs: "14 dní",
        },
      });
      expect(mail.data).not.toHaveProperty("groupName");
      expect(tokenOf(mail)).toHaveLength(43);
      const [row] = await db.select().from(inviteLink).where(eq(inviteLink.employmentId, petra));
      expect(row).toMatchObject({ groupId: null, email: "petra@example.test", usedAt: null });
    });
  });
  const rowOf = async (employmentId: string) => {
    const [row] = await db.select().from(employments).where(eq(employments.id, employmentId));
    return row!;
  };

  const emailOfUser = async (userId: string) => {
    const [row] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
    return row!.email;
  };

  const preview = (token: string) =>
    request(server.url).post("/api/auth/invite/preview").send({ token });

  const joinByLink = async (userId: string, token: string) =>
    (await as(userId)).post("/api/auth/invite/join", { token });

  const signUpWithInvite = (body: { token: string; name: string; email: string }) =>
    request(server.url)
      .post("/api/auth/invite/sign-up")
      .send({ ...body, password: PASSWORD });

  const groupInvite = async (world: World, email: string) => {
    const res = await (
      await as(world.users.owner.id)
    ).post(`/api/group-user/${world.support}/invites`, { email });
    expect(res.status).toBe(201);
    const mail = sentEmails.findLast((m) => m.template === "group-invite");
    return { token: tokenOf(mail), code: res.body.invite.code as string };
  };

  const membersOf = async (groupId: string, userId: string) =>
    db
      .select()
      .from(groupUsers)
      .where(and(eq(groupUsers.groupId, groupId), eq(groupUsers.userId, userId)));

  describe("who may send it, and when", () => {
    it("lets the owner, an org admin and HR send, and refuses a member and a group admin", async () => {
      const world = await setUp();
      const petra = await addPerson(world, { name: "Petra Nová", email: "petra@example.test" });
      const { owner, dana, hana, bob, gabi } = world.users;

      for (const caller of [owner, dana, hana]) {
        expect((await sendInvite(world, petra, caller.id)).status).toBe(201);
      }
      for (const caller of [bob, gabi]) {
        const res = await sendInvite(world, petra, caller.id);
        expect([res.status, code(res)]).toEqual([403, "INVITE_DENIED"]);
      }
    });

    it("refuses sending on a lapsed organization with 402", async () => {
      const world = await setUp();
      const petra = await addPerson(world, { name: "Petra Nová", email: "petra@example.test" });
      await upsertSubscription(world.organizationId, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });

      const res = await sendInvite(world, petra);

      expect(res.status).toBe(402);
      expect(res.body.errors[0].context.reason).toBe("PLAN_LIMIT");
      expect(sentEmails).toHaveLength(0);
      expect(await db.select().from(inviteLink).where(eq(inviteLink.employmentId, petra))).toEqual(
        []
      );
    });

    it("needs an email, and refuses a person with an account or one who left", async () => {
      const world = await setUp();
      const noEmail = await addPerson(world, { name: "Petra Nová" });
      const bob = await employmentIdOf(world.organizationId, world.users.bob.id);
      const leaver = await addPerson(world, { name: "Lea Leaver", email: "lea@example.test" });
      const end = await (
        await as(world.users.owner.id)
      ).post(`/api/employment/${leaver}/end`, { endedOn: new Date().toISOString().slice(0, 10) });
      expect(end.status).toBe(200);

      const [none, bound, ended] = [
        await sendInvite(world, noEmail),
        await sendInvite(world, bob),
        await sendInvite(world, leaver),
      ];

      expect([none.status, code(none)]).toEqual([422, "NO_EMAIL"]);
      expect([bound.status, code(bound)]).toEqual([422, "HAS_ACCOUNT"]);
      expect([ended.status, code(ended)]).toEqual([409, "EMPLOYMENT_ENDED"]);
    });

    it("revokes the earlier invite when sent again", async () => {
      const world = await setUp();
      const petra = await addPerson(world, { name: "Petra Nová", email: "petra@example.test" });
      await sendInvite(world, petra);
      const first = tokenOf(sentEmails[0]);
      await sendInvite(world, petra);
      const second = tokenOf(sentEmails[1]);

      expect((await preview(first)).body.status).toBe("revoked");
      expect((await preview(second)).body.status).toBe("open");
    });

    it("shows Invite sent to the owner, org admins and HR while the invite is open", async () => {
      const world = await setUp();
      const petra = await addPerson(world, { name: "Petra Nová", email: "petra@example.test" });
      const markersFor = async (userId: string) => {
        const res = await (
          await as(userId)
        ).get(`/api/directory/${world.organizationId}/people/${petra}`);
        expect(res.status).toBe(200);
        return res.body.markers as string[];
      };
      expect(await markersFor(world.users.owner.id)).not.toContain("INVITE_SENT");

      await sendInvite(world, petra);

      for (const caller of [world.users.owner, world.users.dana, world.users.hana]) {
        expect(await markersFor(caller.id)).toContain("INVITE_SENT");
      }
      expect(await markersFor(world.users.bob.id)).toEqual([]);
      const list = await (
        await as(world.users.owner.id)
      ).get(`/api/directory/${world.organizationId}/people`);
      expect(
        list.body.people.find((p: { employmentId: string }) => p.employmentId === petra).markers
      ).toEqual(["NO_ACCOUNT", "INVITE_SENT"]);
    });

    it("offers Send invite on the profile to act holders, on an open record without an account", async () => {
      const world = await setUp();
      const petra = await addPerson(world, { name: "Petra Nová" });
      const bob = await employmentIdOf(world.organizationId, world.users.bob.id);
      const actionsOf = async (userId: string, employmentId: string) =>
        (
          await (
            await as(userId)
          ).get(`/api/directory/${world.organizationId}/people/${employmentId}`)
        ).body.actions;

      expect((await actionsOf(world.users.hana.id, petra)).invite).toBe(true);
      expect((await actionsOf(world.users.bob.id, petra)).invite).toBe(false);
      expect((await actionsOf(world.users.owner.id, bob)).invite).toBe(false);
    });
  });

  describe("the Claim", () => {
    it("binds a user to the account-less Employment through a plain group invite whose address matches", async () => {
      const world = await setUp();
      const petra = await addPerson(world, { name: "Petra Nová", email: "petra@example.test" });
      const { token } = await groupInvite(world, "petra@example.test");

      const res = await signUpWithInvite({ token, name: "Petra N.", email: "petra@example.test" });

      expect(res.status).toBe(201);
      const userId = res.body.user.id as string;
      expect(res.body.membership).toMatchObject({
        groupId: world.support,
        claimed: { employmentId: petra, organizationId: world.organizationId },
      });
      expect(await rowOf(petra)).toMatchObject({
        userId,
        endedAt: null,
        name: "Petra N.",
        email: "petra@example.test",
      });
      expect(await membersOf(world.support, userId)).toHaveLength(1);
      const open = await db
        .select()
        .from(employments)
        .where(and(eq(employments.userId, userId), isNull(employments.endedAt)));
      expect(open.map((row) => row.id)).toEqual([petra]);
    });

    it("binds an existing account redeeming a plain group invite by code", async () => {
      const world = await setUp();
      const joiner = await makeUser("Petra Joiner");
      const email = await emailOfUser(joiner.id);
      const petra = await addPerson(world, { name: "Petra Nová", email });
      const { code: inviteCode } = await groupInvite(world, email);

      const res = await (await as(joiner.id)).post(`/api/group-user/code/${inviteCode}`, {});

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ groupId: world.support, claimed: { employmentId: petra } });
      expect((await rowOf(petra)).userId).toBe(joiner.id);
    });

    it("binds through a directory invite that names no group, and joins no group", async () => {
      const world = await setUp();
      const joiner = await makeUser("Petra Joiner");
      const email = await emailOfUser(joiner.id);
      const petra = await addPerson(world, { name: "Petra Nová", email });
      await sendInvite(world, petra);
      const token = tokenOf(sentEmails[0]);

      const res = await joinByLink(joiner.id, token);

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        groupId: null,
        claimed: { employmentId: petra, organizationId: world.organizationId },
      });
      expect((await rowOf(petra)).userId).toBe(joiner.id);
      expect(await db.select().from(groupUsers).where(eq(groupUsers.userId, joiner.id))).toEqual(
        []
      );
      expect((await preview(token)).body.status).toBe("used");
      const profile = await (
        await as(world.users.owner.id)
      ).get(`/api/directory/${world.organizationId}/people/${petra}`);
      expect(profile.body.markers).not.toContain("INVITE_SENT");
      expect(profile.body.markers).not.toContain("NO_ACCOUNT");
    });

    it("joins the group a directory invite names, as well as binding", async () => {
      const world = await setUp();
      const petra = await addPerson(world, { name: "Petra Nová", email: "petra@example.test" });
      expect(
        (await sendInvite(world, petra, world.users.owner.id, { groupId: world.support })).status
      ).toBe(201);

      const res = await signUpWithInvite({
        token: tokenOf(sentEmails[0]),
        name: "Petra Nová",
        email: "petra@example.test",
      });

      expect(res.status).toBe(201);
      expect(await membersOf(world.support, res.body.user.id)).toHaveLength(1);
      expect((await rowOf(petra)).userId).toBe(res.body.user.id);
    });

    it("describes a directory invite by the organization and the person's name", async () => {
      const world = await setUp();
      const petra = await addPerson(world, { name: "Petra Nová", email: "petra@example.test" });
      await sendInvite(world, petra);

      const res = await preview(tokenOf(sentEmails[0]));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        groupId: null,
        groupName: null,
        organizationName: sentEmails[0]!.data.organizationName,
        personName: "Petra Nová",
        inviterName: "Olga Owner",
        invitedEmail: "petra@example.test",
        status: "open",
      });
    });

    it("fills the name in for a plain group invite whose address a person without an account holds", async () => {
      const world = await setUp();
      await addPerson(world, { name: "Petra Nová", email: "petra@example.test" });
      const other = await groupInvite(world, "someone@example.test");
      const matching = await groupInvite(world, "petra@example.test");

      expect((await preview(matching.token)).body).toMatchObject({
        groupName: "Support",
        personName: "Petra Nová",
      });
      expect((await preview(other.token)).body.personName).toBeNull();
    });

    it("refuses the bind when the user already has an open Employment there, and writes nothing", async () => {
      const world = await setUp();
      const petra = await addPerson(world, { name: "Petra Nová", email: "petra@example.test" });
      await sendInvite(world, petra);
      const token = tokenOf(sentEmails[0]);
      // Bob's address changes to Petra's after she was added: two open records, one person.
      await db
        .update(user)
        .set({ email: "petra@example.test" })
        .where(eq(user.id, world.users.bob.id));

      const res = await joinByLink(world.users.bob.id, token);

      expect([res.status, code(res)]).toEqual([409, "ALREADY_EMPLOYED"]);
      expect((await rowOf(petra)).userId).toBeNull();
      expect((await preview(token)).body.status).toBe("open");
    });

    it("never binds a sign-up with a matching email and no invite", async () => {
      const world = await setUp();
      const petra = await addPerson(world, { name: "Petra Nová", email: "petra@example.test" });

      const res = await request(server.url)
        .post("/api/auth/sign-up/email")
        .set("Origin", "http://localhost:3000")
        .send({ name: "Petra Nová", email: "petra@example.test", password: PASSWORD });

      expect(res.status).toBe(200);
      const [account] = await db.select().from(user).where(eq(user.email, "petra@example.test"));
      expect(account).toBeDefined();
      expect((await rowOf(petra)).userId).toBeNull();
      expect(
        await db.select().from(employments).where(eq(employments.userId, account!.id))
      ).toEqual([]);
    });

    it("lets the name and email follow the account after binding", async () => {
      const world = await setUp();
      const joiner = await makeUser("Petra Joiner");
      const email = await emailOfUser(joiner.id);
      const petra = await addPerson(world, { name: "Petra Nová", email });
      await sendInvite(world, petra);
      expect((await joinByLink(joiner.id, tokenOf(sentEmails[0]))).status).toBe(201);
      expect((await rowOf(petra)).name).toBe("Petra Joiner");

      const rename = await request(server.url)
        .post("/api/auth/update-user")
        .set("Cookie", await authCookieFor(joiner.id))
        .set("Origin", "http://localhost:3000")
        .send({ name: "Petra Svobodová" });
      expect(rename.status).toBe(200);
      await db.update(user).set({ email: "petra.new@example.test" }).where(eq(user.id, joiner.id));

      expect(await rowOf(petra)).toMatchObject({
        name: "Petra Svobodová",
        email: "petra.new@example.test",
      });
      const profile = await (
        await as(world.users.owner.id)
      ).get(`/api/directory/${world.organizationId}/people/${petra}`);
      expect(profile.body.name).toBe("Petra Svobodová");
      expect(profile.body.sections.card.nameFromAccount).toBe(true);
    });

    it("keeps binding while the directory is off", async () => {
      const world = await setUp();
      const petra = await addPerson(world, { name: "Petra Nová", email: "petra@example.test" });
      const { token } = await groupInvite(world, "petra@example.test");
      await db.transaction((tx) =>
        disableDirectory({ organizationId: world.organizationId, userId: world.users.owner.id }, tx)
      );

      const res = await signUpWithInvite({
        token,
        name: "Petra Nová",
        email: "petra@example.test",
      });

      expect(res.status).toBe(201);
      expect((await rowOf(petra)).userId).toBe(res.body.user.id);
    });

    it("stops a directory invite once its person has ended, and Erase removes it", async () => {
      const world = await setUp();
      const joiner = await makeUser("Petra Joiner");
      const email = await emailOfUser(joiner.id);
      const petra = await addPerson(world, { name: "Petra Nová", email });
      await sendInvite(world, petra);
      const token = tokenOf(sentEmails[0]);
      const end = await (
        await as(world.users.owner.id)
      ).post(`/api/employment/${petra}/end`, { endedOn: new Date().toISOString().slice(0, 10) });
      expect(end.status).toBe(200);

      const res = await joinByLink(joiner.id, token);

      expect([res.status, code(res)]).toEqual([410, "INVITE_REVOKED"]);
      expect((await rowOf(petra)).userId).toBeNull();

      const erase = await (
        await as(world.users.owner.id)
      ).post(`/api/employment/${petra}/erase`, { confirmName: "Petra Nová" });
      expect(erase.status).toBe(204);
      expect(await db.select().from(inviteLink).where(eq(inviteLink.email, email))).toEqual([]);
    });
  });
  describe("editing the email of a person without an account", () => {
    const patchEmail = async (
      world: World,
      employmentId: string,
      email: string | null,
      callerId = world.users.owner.id
    ) =>
      (await as(callerId)).patch(`/api/directory/${world.organizationId}/people/${employmentId}`, {
        card: { email },
      });

    const historyOf = (employmentId: string) =>
      db
        .select()
        .from(directoryProfileHistory)
        .where(eq(directoryProfileHistory.employmentId, employmentId));

    it("sets, changes and clears the email, each with a Card history entry", async () => {
      const world = await setUp();
      const petra = await addPerson(world, { name: "Petra Nová" });

      const set = await patchEmail(world, petra, "Petra@Example.test");
      expect(set.status).toBe(200);
      expect(set.body.account.signInEmail).toBe("petra@example.test");
      expect(
        (await patchEmail(world, petra, "petra.n@example.test", world.users.hana.id)).status
      ).toBe(200);
      expect((await rowOf(petra)).email).toBe("petra.n@example.test");
      expect((await patchEmail(world, petra, null)).status).toBe(200);

      expect((await rowOf(petra)).email).toBeNull();
      const entries = (await historyOf(petra)).filter((entry) => entry.fields.includes("email"));
      expect(entries).toHaveLength(3);
      expect(entries.map((entry) => entry.section)).toEqual(["CARD", "CARD", "CARD"]);
      expect(entries.map((entry) => entry.audience).sort()).toEqual(["HR", "OWNER", "OWNER"]);
    });

    it("refuses a viewer who can't write the Card", async () => {
      const world = await setUp();
      const petra = await addPerson(world, { name: "Petra Nová" });

      const res = await patchEmail(world, petra, "petra@example.test", world.users.bob.id);

      expect([res.status, code(res)]).toEqual([403, "SECTION_NOT_WRITABLE"]);
      expect((await rowOf(petra)).email).toBeNull();
    });

    it("still refuses the email of a bound person and of one who left", async () => {
      const world = await setUp();
      const bob = await employmentIdOf(world.organizationId, world.users.bob.id);
      const leaver = await addPerson(world, { name: "Lea Leaver", email: "lea@example.test" });
      await (
        await as(world.users.owner.id)
      ).post(`/api/employment/${leaver}/end`, { endedOn: new Date().toISOString().slice(0, 10) });

      const bound = await patchEmail(world, bob, "other@example.test");
      const ended = await patchEmail(world, leaver, "other@example.test");

      expect([bound.status, code(bound)]).toEqual([422, "EMAIL_FROM_ACCOUNT"]);
      expect([ended.status, code(ended)]).toEqual([422, "EMAIL_FROM_ACCOUNT"]);
      expect((await rowOf(leaver)).email).toBe("lea@example.test");
    });

    it("refuses an address another open Employment holds, ignoring case", async () => {
      const world = await setUp();
      const petra = await addPerson(world, { name: "Petra Nová" });
      await addPerson(world, { name: "Karel Novák", email: "karel@example.test" });
      const bobEmail = await emailOfUser(world.users.bob.id);

      const bound = await patchEmail(world, petra, bobEmail.toUpperCase());
      const accountless = await patchEmail(world, petra, "KAREL@example.test");

      expect([bound.status, code(bound)]).toEqual([409, "EMPLOYMENT_EMAIL_TAKEN"]);
      expect([accountless.status, code(accountless)]).toEqual([409, "EMPLOYMENT_EMAIL_TAKEN"]);
      expect((await rowOf(petra)).email).toBeNull();
      expect((await patchEmail(world, petra, "petra@example.test")).status).toBe(200);
      expect((await patchEmail(world, petra, "PETRA@example.test")).status).toBe(200);
    });

    it("needs the plan to set an email, not to clear one", async () => {
      const world = await setUp();
      const petra = await addPerson(world, { name: "Petra Nová", email: "petra@example.test" });
      await upsertSubscription(world.organizationId, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });

      const set = await patchEmail(world, petra, "petra.n@example.test");
      const clear = await patchEmail(world, petra, null);

      expect([set.status, set.body.errors?.[0]?.context?.reason]).toEqual([402, "PLAN_LIMIT"]);
      expect(clear.status).toBe(200);
      expect((await rowOf(petra)).email).toBeNull();
    });

    it("revokes the open directory invite when the address changes", async () => {
      const world = await setUp();
      const petra = await addPerson(world, { name: "Petra Nová", email: "petra@example.test" });
      await sendInvite(world, petra);
      const token = tokenOf(sentEmails[0]);

      const res = await patchEmail(world, petra, "petra.n@example.test");

      expect(res.status).toBe(200);
      expect(res.body.markers).not.toContain("INVITE_SENT");
      expect((await preview(token)).body.status).toBe("revoked");
    });
  });
});

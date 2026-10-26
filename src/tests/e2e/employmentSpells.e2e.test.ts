import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/db.js";
import { employments, workerType } from "../../db/schema/employment-schema.js";
import { attendanceSessions } from "../../db/schema/attendance-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { inviteLink } from "../../db/schema/invite-link-schema.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { generateInviteCode } from "../../utils/inviteCode.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { cleanupTestData, createTestUser } from "./helpers/testSetup.js";
import { getEmployment, listEmployments } from "../../services/employment/employmentServices.js";
import { canReadEmployment } from "../../services/employment/attendanceAccess.js";
import { resolveAttendanceSubject } from "../../services/attendance/attendanceServices.js";
import { collectOrganizationExport } from "../../services/personExport/organizationExportData.js";
import { organizationPeople } from "../../services/personExport/organizationExportServices.js";
import { createGroup } from "../../services/group/groupServices.js";
import {
  createGroupUser,
  deleteGroupUser,
  getGroupUser,
} from "../../services/groupUser/groupUserServices.js";
import {
  ensureOrganizationForUser,
  grantOrganizationAdmin,
} from "../../services/organization/organizationServices.js";

const ZONE = "Europe/Prague";

/** One Employment per spell (T-497): a rejoin starts a new row. */
describe("Employments by spell", () => {
  let organizationId: string;
  let owner: { id: string };
  let server: LoopbackServer;

  const userOf = async (slug: string) =>
    createTestUser(`spells-${slug}@spells-e2e.test`, `Spells ${slug}`, "password123");

  const newGroup = async (name: string) => {
    const record = await createGroup({
      id: uuidv4(),
      organizationId,
      groupName: name,
      managerUserId: owner.id,
    });
    return record!.id;
  };

  const addMember = async (groupId: string, userId: string) =>
    createGroupUser({ id: uuidv4(), groupId, userId, viewAccess: true, controlledUser: true });

  const removeMember = async (groupId: string, userId: string) => {
    const membership = await getGroupUser(userId, groupId);
    await deleteGroupUser(membership!.id);
  };

  /** An account-less Employment, as Add person (T-508) will write it. */
  const accountless = async (email: string, options: { endedAt?: Date } = {}) => {
    const id = uuidv4();
    await db.insert(employments).values({
      id,
      organizationId,
      userId: null,
      name: "No Account Person",
      email,
      endedAt: options.endedAt ?? null,
    });
    return id;
  };

  const openInvite = async (groupId: string) => {
    const code = generateInviteCode();
    await db.insert(inviteLink).values({
      id: uuidv4(),
      groupId,
      code,
      invitedByUserId: owner.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    return code;
  };

  const errorCode = (res: request.Response) =>
    (res.body as { errors: { context?: { code?: string } }[] }).errors[0]?.context?.code;

  const spellsOf = (userId: string) =>
    db
      .select()
      .from(employments)
      .where(and(eq(employments.organizationId, organizationId), eq(employments.userId, userId)))
      .orderBy(asc(employments.startedAt));

  beforeAll(async () => {
    await cleanupTestData();
    owner = await userOf("owner");
    organizationId = (await ensureOrganizationForUser(owner.id)).id;
    server = await listenOnLoopback(createServer());
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  describe("a rejoin", () => {
    it("starts a second Employment and leaves the first spell's attendance on it", async () => {
      const returner = await userOf("returner");
      const groupId = await newGroup("Returners");
      await addMember(groupId, returner.id);
      const first = await getEmployment(organizationId, returner.id);
      const sessionId = uuidv4();
      await db.insert(attendanceSessions).values({
        id: sessionId,
        employmentId: first!.id,
        businessDate: "2026-09-01",
        startedAt: new Date("2026-09-01T07:00:00Z"),
        endedAt: new Date("2026-09-01T15:00:00Z"),
        timezone: ZONE,
      });
      await removeMember(groupId, returner.id);

      await addMember(groupId, returner.id);

      const spells = await spellsOf(returner.id);
      expect(spells).toHaveLength(2);
      expect(spells[0]!.id).toBe(first!.id);
      expect(spells[0]!.endedAt).not.toBeNull();
      expect(spells[1]!.endedAt).toBeNull();
      expect((await getEmployment(organizationId, returner.id))?.id).toBe(spells[1]!.id);
      const [session] = await db
        .select({ employmentId: attendanceSessions.employmentId })
        .from(attendanceSessions)
        .where(eq(attendanceSessions.id, sessionId));
      expect(session?.employmentId).toBe(first!.id);
    });

    it("answers with the latest spell once every spell has ended", async () => {
      const leaver = await userOf("twice-gone");
      const groupId = await newGroup("Twice gone");
      await addMember(groupId, leaver.id);
      await removeMember(groupId, leaver.id);
      await addMember(groupId, leaver.id);
      await removeMember(groupId, leaver.id);
      const [, latest] = await spellsOf(leaver.id);

      expect((await getEmployment(organizationId, leaver.id))?.id).toBe(latest!.id);
      expect((await resolveAttendanceSubject(leaver.id, organizationId))?.employment.id).toBe(
        latest!.id
      );
      expect((await resolveAttendanceSubject(leaver.id, undefined))?.employment.id).toBe(
        latest!.id
      );
    });

    it("leaves the open spell alone when the person joins a second group", async () => {
      const dual = await userOf("dual");
      await addMember(await newGroup("Dual A"), dual.id);
      const opened = await getEmployment(organizationId, dual.id);

      await addMember(await newGroup("Dual B"), dual.id);

      const spells = await spellsOf(dual.id);
      expect(spells).toHaveLength(1);
      expect(spells[0]).toEqual(opened);
    });
  });

  describe("a join path that meets an account-less Employment's email", () => {
    it("refuses an invite redemption with a 409 and writes nothing", async () => {
      const joiner = await userOf("invitee");
      const recordId = await accountless(joiner.email.toUpperCase());
      const groupId = await newGroup("Invitees");
      const code = await openInvite(groupId);

      const res = await request(server.url)
        .post(`/api/group-user/code/${code}`)
        .set("Cookie", await authCookieFor(joiner.id));

      expect(res.status).toBe(409);
      expect(errorCode(res)).toBe("ACCOUNTLESS_EMPLOYMENT_EMAIL");
      expect(await spellsOf(joiner.id)).toHaveLength(0);
      const memberships = await db
        .select()
        .from(groupUsers)
        .where(and(eq(groupUsers.userId, joiner.id), isNull(groupUsers.deletedAt)));
      expect(memberships).toHaveLength(0);
      const [record] = await db.select().from(employments).where(eq(employments.id, recordId));
      expect(record).toMatchObject({ userId: null, endedAt: null, type: workerType.Employee });
    });

    it("refuses an org-admin grant and a new group manager", async () => {
      const delegate = await userOf("delegate-clash");
      const manager = await userOf("manager-clash");
      await accountless(delegate.email);
      await accountless(manager.email);

      await expect(
        grantOrganizationAdmin({ organizationId, userId: delegate.id, grantedByUserId: owner.id })
      ).rejects.toMatchObject({ code: 409 });
      await expect(
        db.transaction((tx) =>
          createGroup(
            {
              id: uuidv4(),
              organizationId,
              groupName: "Clashing manager",
              managerUserId: manager.id,
            },
            tx
          )
        )
      ).rejects.toMatchObject({ code: 409 });

      expect(await spellsOf(delegate.id)).toHaveLength(0);
      expect(await spellsOf(manager.id)).toHaveLength(0);
    });

    it("lets the person join once the account-less Employment has ended", async () => {
      const joiner = await userOf("after-end");
      await accountless(joiner.email, { endedAt: new Date() });

      await addMember(await newGroup("After end"), joiner.id);

      expect((await getEmployment(organizationId, joiner.id))?.endedAt).toBeNull();
    });

    it("leaves an Employment that is already open alone", async () => {
      const member = await userOf("already-open");
      await addMember(await newGroup("Already open A"), member.id);
      await accountless(member.email);

      await addMember(await newGroup("Already open B"), member.id);

      expect(await spellsOf(member.id)).toHaveLength(1);
    });
  });

  describe("an account-less Employment, to every reader", () => {
    let recordId: string;
    let ownerCookie: string;
    let groupAdmin: { id: string };

    beforeAll(async () => {
      recordId = await accountless("nobody@spells-e2e.test");
      ownerCookie = await authCookieFor(owner.id);
      groupAdmin = await userOf("group-admin");
      const groupId = await newGroup("Readers");
      await createGroupUser({
        id: uuidv4(),
        groupId,
        userId: groupAdmin.id,
        viewAccess: true,
        adminAccess: true,
        controlledUser: true,
      });
    });

    it("is on the roster by its own copy, for org admins only", async () => {
      const res = await request(server.url)
        .get("/api/employment/list")
        .query({ organizationId })
        .set("Cookie", ownerCookie);

      expect(res.status).toBe(200);
      const row = (res.body as { id: string }[]).find((entry) => entry.id === recordId);
      expect(row).toMatchObject({
        userId: null,
        type: "employee",
        email: "nobody@spells-e2e.test",
        ended: false,
        accountDeleted: false,
        user: { id: recordId, name: "No Account Person", initials: "NP" },
      });
      const slice = await listEmployments(organizationId, { userIds: [groupAdmin.id] });
      expect(slice.map((entry) => entry.id)).not.toContain(recordId);
      expect(await canReadEmployment(owner.id, { organizationId, userId: null })).toBe(true);
      expect(await canReadEmployment(groupAdmin.id, { organizationId, userId: null })).toBe(false);
    });

    it("stays off Team attendance", async () => {
      const res = await request(server.url)
        .get("/api/attendance/team")
        .query({ organizationId, from: "2026-10-01", to: "2026-10-01" })
        .set("Cookie", ownerCookie);

      expect(res.status).toBe(200);
      const people = res.body.people as { employmentId: string; userId: string | null }[];
      expect(people.map((person) => person.employmentId)).not.toContain(recordId);
      expect(people.every((person) => person.userId !== null)).toBe(true);
    });

    it("does not block the owner's account deletion", async () => {
      const res = await request(server.url)
        .get("/api/users/me/deletion")
        .set("Cookie", ownerCookie);

      expect(res.status).toBe(200);
      const blockers = res.body.blockers as { kind: string; otherMembers?: number }[];
      const members = blockers.find((blocker) => blocker.kind === "ORGANIZATION_HAS_MEMBERS");
      const employed = (await listEmployments(organizationId, { active: true })).filter(
        (entry) => entry.userId !== null && entry.userId !== owner.id && !entry.accountDeleted
      );
      expect(members?.otherMembers ?? 0).toBe(employed.length);
    });

    it("is refused by End employment, Erase and the Person export with a clear code", async () => {
      const end = await request(server.url)
        .post(`/api/employment/${recordId}/end`)
        .set("Cookie", ownerCookie)
        .send({ endedOn: "2026-10-01" });
      const erase = await request(server.url)
        .post(`/api/employment/${recordId}/erase`)
        .set("Cookie", ownerCookie)
        .send({ confirmName: "No Account Person" });
      const personExport = await request(server.url)
        .post(`/api/employment/${recordId}/export`)
        .set("Cookie", ownerCookie);

      expect([end.status, errorCode(end)]).toEqual([422, "ACCOUNT_NOT_DELETED"]);
      expect([erase.status, errorCode(erase)]).toEqual([422, "ACCOUNT_NOT_DELETED"]);
      expect([personExport.status, errorCode(personExport)]).toEqual([422, "NO_ACCOUNT"]);
      const [record] = await db.select().from(employments).where(eq(employments.id, recordId));
      expect(record?.endedAt).toBeNull();
    });

    it("goes into the Organization export as a person without an account", async () => {
      const { document, people } = await collectOrganizationExport(organizationId);

      expect(document.peopleWithoutAccount).toContainEqual(
        expect.objectContaining({
          employmentId: recordId,
          name: "No Account Person",
          email: "nobody@spells-e2e.test",
          type: "employee",
        })
      );
      expect(people.every((person) => typeof person.userId === "string")).toBe(true);
      const logged = await organizationPeople(organizationId);
      expect(logged.flatMap((person) => person.employmentIds)).not.toContain(recordId);
    });
  });
});

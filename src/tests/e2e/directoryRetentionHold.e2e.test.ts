import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { directoryRoleAssignments, directoryRole } from "../../db/schema/directory-role-schema.js";
import { directorySensitiveProfiles } from "../../db/schema/directory-sensitive-profile-schema.js";
import { directoryProfiles } from "../../db/schema/directory-profile-schema.js";
import { directoryRetentionHolds } from "../../db/schema/directory-retention-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { purgeRetention } from "../../services/directory/retentionPurge.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { addMember, makeGroup, makeUser } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { apiAs, enableEnterpriseDirectory, errorCode as code } from "./helpers/directoryWorld.js";

const DAY = 24 * 60 * 60 * 1000;
const later = (days: number, from = new Date()) => new Date(from.getTime() + days * DAY);
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

const FILLED = {
  card: { jobTitle: "Accountant" },
  workContact: { workEmail: "jana@work.test", workPhone: "+420 777 000 111" },
  job: { legalName: "Jana Nováková", contractType: "PERMANENT" },
  contact: { privatePhone: "+420 777 123 456", privateEmail: "jana@home.test" },
  personal: { dateOfBirth: "1990-04-17" },
};

describe("Retention holds and removal dates", () => {
  let server: LoopbackServer;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    await cleanupTestData();
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  /**
   * Olga owns the organization and manages Support. In Support: Jana and
   * Pavel (members who leave), Dana (org-admin grant), Hana (HR) and Mira (a
   * member who stays).
   */
  const setUp = async () => {
    const owner = await makeUser("Olga Owner");
    const jana = await makeUser("Jana Member");
    const pavel = await makeUser("Pavel Member");
    const dana = await makeUser("Dana Delegate");
    const hana = await makeUser("Hana Human");
    const mira = await makeUser("Mira Member");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    const support = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    await addMember(support, owner.id);
    await syncEmployment(organizationId, owner.id);
    for (const person of [jana, pavel, dana, hana, mira]) {
      await addMember(support, person.id);
      await syncEmployment(organizationId, person.id);
    }
    await db.insert(organizationUsers).values({
      id: generateRandomUUID(),
      organizationId,
      userId: dana.id,
      grantedByUserId: owner.id,
    });
    await enableEnterpriseDirectory(organizationId, owner.id);
    const employmentOf = async (userId: string) => {
      const [row] = await db
        .select({ id: employments.id })
        .from(employments)
        .where(and(eq(employments.userId, userId), eq(employments.organizationId, organizationId)));
      return row!.id;
    };
    await db.insert(directoryRoleAssignments).values({
      employmentId: await employmentOf(hana.id),
      role: directoryRole.Hr,
      organizationId,
      assignedByUserId: owner.id,
    });
    return {
      organizationId,
      users: { owner, jana, pavel, dana, hana, mira },
      employment: {
        jana: await employmentOf(jana.id),
        pavel: await employmentOf(pavel.id),
        mira: await employmentOf(mira.id),
      },
      path: (employmentId: string) => `/api/directory/${organizationId}/people/${employmentId}`,
      hold: (employmentId: string) =>
        `/api/directory/${organizationId}/people/${employmentId}/hold`,
      former: `/api/directory/${organizationId}/former`,
      settings: `/api/directory/${organizationId}/settings/retention`,
    };
  };
  type Fixture = Awaited<ReturnType<typeof setUp>>;

  const as = (userId: string) => apiAs(server.url, userId);

  const fill = async (fixture: Fixture, employmentId: string) => {
    const owner = await as(fixture.users.owner.id);
    const saved = await owner.patch(fixture.path(employmentId), FILLED);
    expect(saved.status).toBe(200);
  };

  const end = async (callerId: string, employmentId: string, endedOn = isoDay(new Date())) =>
    (await as(callerId)).post(`/api/employment/${employmentId}/end`, { endedOn });

  const stored = async (employmentId: string) => {
    const [profile] = await db
      .select()
      .from(directoryProfiles)
      .where(eq(directoryProfiles.employmentId, employmentId));
    const [sensitive] = await db
      .select()
      .from(directorySensitiveProfiles)
      .where(eq(directorySensitiveProfiles.employmentId, employmentId));
    return { profile, sensitive };
  };

  describe("the hold", () => {
    it("keeps every Section through the nightly step, and lifting it lets the next run purge what is due", async () => {
      const fixture = await setUp();
      const { employment, users } = fixture;
      await fill(fixture, employment.jana);
      expect((await end(users.owner.id, employment.jana)).status).toBe(200);
      const owner = await as(users.owner.id);

      const held = await owner.put(fixture.hold(employment.jana));
      expect(held.status).toBe(200);

      expect(await purgeRetention(later(4 * 366))).toBe(0);
      const kept = await stored(employment.jana);
      expect(kept.profile).toMatchObject({ workEmail: "jana@work.test" });
      expect(kept.sensitive).toMatchObject({
        contact: expect.any(String),
        personal: expect.any(String),
      });

      const lifted = await owner.delete(fixture.hold(employment.jana));
      expect(lifted.status).toBe(200);
      expect(lifted.body).toEqual({ hold: null });

      expect(await purgeRetention(later(31))).toBe(2);
      const purged = await stored(employment.jana);
      expect(purged.profile).toMatchObject({ workEmail: null, jobTitle: "Accountant" });
      expect(purged.sensitive).toMatchObject({ contact: null, personal: expect.any(String) });
    });

    it("is set and lifted by the owner and org admins only, and the profile shows who set it and when", async () => {
      const fixture = await setUp();
      const { employment, users } = fixture;
      expect((await end(users.owner.id, employment.jana)).status).toBe(200);
      const hr = await as(users.hana.id);
      const member = await as(users.mira.id);
      const delegate = await as(users.dana.id);

      const denied = await hr.put(fixture.hold(employment.jana));
      expect(denied.status).toBe(403);
      expect(code(denied)).toBe("HOLD_DENIED");
      expect(code(await member.put(fixture.hold(employment.jana)))).toBe("HOLD_DENIED");
      const open = await delegate.put(fixture.hold(employment.mira));
      expect(open.status).toBe(422);
      expect(code(open)).toBe("EMPLOYMENT_OPEN");

      const before = Date.now();
      const set = await delegate.put(fixture.hold(employment.jana));
      expect(set.status).toBe(200);
      expect(set.body.hold).toEqual({
        setAt: expect.any(String),
        setBy: { userId: users.dana.id, name: "Dana Delegate" },
      });
      expect(Date.parse(set.body.hold.setAt)).toBeGreaterThanOrEqual(before - 1000);

      const again = await (await as(users.owner.id)).put(fixture.hold(employment.jana));
      expect(again.body.hold).toEqual(set.body.hold);

      const seenByHr = await hr.get(fixture.path(employment.jana));
      expect(seenByHr.status).toBe(200);
      expect(seenByHr.body.retention.hold).toEqual(set.body.hold);
      expect(seenByHr.body.actions.hold).toBe(false);
      const seenByDelegate = await delegate.get(fixture.path(employment.jana));
      expect(seenByDelegate.body.actions.hold).toBe(true);

      expect(code(await hr.delete(fixture.hold(employment.jana)))).toBe("HOLD_DENIED");
      expect((await delegate.delete(fixture.hold(employment.jana))).status).toBe(200);
      expect((await hr.get(fixture.path(employment.jana))).body.retention.hold).toBeNull();
    });

    it("leaves Erase working while it is on", async () => {
      const fixture = await setUp();
      const { employment, users } = fixture;
      await fill(fixture, employment.jana);
      expect((await end(users.owner.id, employment.jana)).status).toBe(200);
      const owner = await as(users.owner.id);
      expect((await owner.put(fixture.hold(employment.jana))).status).toBe(200);
      await db
        .update(employments)
        .set({ accountDeletedAt: new Date() })
        .where(eq(employments.id, employment.jana));

      const erased = await owner.post(`/api/employment/${employment.jana}/erase`, {
        confirmName: "Jana Member",
      });
      expect(erased.status).toBe(204);
      expect(
        await db
          .select()
          .from(directoryRetentionHolds)
          .where(eq(directoryRetentionHolds.employmentId, employment.jana))
      ).toEqual([]);
      expect(
        await db.select().from(employments).where(eq(employments.id, employment.jana))
      ).toEqual([]);
      expect(await stored(employment.jana)).toEqual({ profile: undefined, sensitive: undefined });
    });
  });
  /** Ends Jana and pins her clock to 2030-01-15 10:00 UTC, so every date is a literal. */
  const CLOCK = new Date("2030-01-15T10:00:00Z");
  const endWithPinnedClock = async (fixture: Fixture, employmentId: string) => {
    expect((await end(fixture.users.owner.id, employmentId)).status).toBe(200);
    await db
      .update(employments)
      .set({ endedAt: CLOCK, endRecordedAt: CLOCK })
      .where(eq(employments.id, employmentId));
  };

  const pragueToday = () =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Prague",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

  describe("removal dates on a former profile", () => {
    it("shows each Section's removal day before a purge and the purge's day after it", async () => {
      const fixture = await setUp();
      const { employment, users } = fixture;
      await fill(fixture, employment.jana);
      await endWithPinnedClock(fixture, employment.jana);
      const owner = await as(users.owner.id);

      const before = await owner.get(fixture.path(employment.jana));
      expect(before.status).toBe(200);
      expect(before.body.retention).toEqual({
        hold: null,
        sections: {
          card: { status: "KEPT_UNTIL_ERASED" },
          workContact: { status: "REMOVES_ON", date: "2030-02-15" },
          job: { status: "KEPT_UNTIL_ERASED" },
          contact: { status: "REMOVES_ON", date: "2030-02-15" },
          personal: { status: "REMOVES_ON", date: "2033-01-16" },
        },
      });

      await purgeRetention(new Date("2030-02-16T00:00:00Z"));
      const after = await owner.get(fixture.path(employment.jana));
      expect(after.body.retention.sections).toEqual({
        card: { status: "KEPT_UNTIL_ERASED" },
        workContact: { status: "REMOVED_ON", date: pragueToday() },
        job: { status: "KEPT_UNTIL_ERASED" },
        contact: { status: "REMOVED_ON", date: pragueToday() },
        personal: { status: "REMOVES_ON", date: "2033-01-16" },
      });

      expect((await owner.put(fixture.hold(employment.jana))).status).toBe(200);
      const held = await owner.get(fixture.path(employment.jana));
      expect(held.body.retention.sections).toEqual({
        card: { status: "KEPT_UNTIL_ERASED" },
        workContact: { status: "REMOVED_ON", date: pragueToday() },
        job: { status: "KEPT_UNTIL_ERASED" },
        contact: { status: "REMOVED_ON", date: pragueToday() },
        personal: { status: "ON_HOLD" },
      });
    });

    it("follows the organization's current periods, and an open profile carries none", async () => {
      const fixture = await setUp();
      const { employment, users } = fixture;
      await fill(fixture, employment.jana);
      await endWithPinnedClock(fixture, employment.jana);
      const owner = await as(users.owner.id);
      await owner.put(fixture.settings, { section: "CARD", period: "YEARS_5" });
      await owner.put(fixture.settings, { section: "CONTACT", period: "UNTIL_ERASED" });

      const profile = await owner.get(fixture.path(employment.jana));
      expect(profile.body.retention.sections).toMatchObject({
        card: { status: "REMOVES_ON", date: "2035-01-16" },
        contact: { status: "KEPT_UNTIL_ERASED" },
      });
      expect((await owner.get(fixture.path(employment.mira))).body.retention).toBeUndefined();
    });
  });

  describe("the Former list", () => {
    it("shows the next removal and the hold, account deleted and rejoined markers", async () => {
      const fixture = await setUp();
      const { employment, users, organizationId } = fixture;
      await fill(fixture, employment.jana);
      await endWithPinnedClock(fixture, employment.jana);
      expect((await end(users.owner.id, employment.pavel)).status).toBe(200);
      await db
        .update(employments)
        .set({ accountDeletedAt: new Date() })
        .where(eq(employments.id, employment.pavel));
      await db.insert(employments).values({
        id: generateRandomUUID(),
        organizationId,
        userId: users.jana.id,
        name: "Jana Member",
        email: users.jana.email,
        startedAt: new Date("2030-03-01T08:00:00Z"),
      });
      const owner = await as(users.owner.id);
      const hr = await as(users.hana.id);

      const rowOf = (body: { employmentId: string }[], id: string) =>
        body.find((row) => row.employmentId === id);
      const list = await hr.get(fixture.former);
      expect(list.status).toBe(200);
      expect(rowOf(list.body, employment.jana)).toMatchObject({
        nextRemoval: { section: "workContact", date: "2030-02-15" },
        hold: false,
        markers: ["REJOINED"],
      });
      expect(rowOf(list.body, employment.pavel)).toMatchObject({
        nextRemoval: null,
        hold: false,
        markers: ["ACCOUNT_DELETED"],
      });

      await purgeRetention(new Date("2030-02-16T00:00:00Z"));
      expect(rowOf((await hr.get(fixture.former)).body, employment.jana)).toMatchObject({
        nextRemoval: { section: "personal", date: "2033-01-16" },
      });

      expect((await owner.put(fixture.hold(employment.jana))).status).toBe(200);
      expect(rowOf((await hr.get(fixture.former)).body, employment.jana)).toMatchObject({
        nextRemoval: null,
        hold: true,
      });
    });
  });
});

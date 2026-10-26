import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import sharp from "sharp";
import { and, eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { directoryPhotos } from "../../db/schema/directory-photo-schema.js";
import {
  directoryProfileHistory,
  directoryProfiles,
} from "../../db/schema/directory-profile-schema.js";
import { directoryRoleAssignments, directoryRole } from "../../db/schema/directory-role-schema.js";
import { directorySensitiveProfiles } from "../../db/schema/directory-sensitive-profile-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import {
  disableDirectory,
  enableDirectory,
} from "../../services/directory/directorySettingsServices.js";
import { runRetentionPurge } from "../../jobs/retentionPurgeJob.js";
import { purgeRetention } from "../../services/directory/retentionPurge.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { organizationDataStore } from "../../services/organizationData/organizationDataStore.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { addMember, makeGroup, makeUser } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

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

describe("Retention periods and purges", () => {
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
   * member who stays). Every spell started on 2025-01-06, so an ending can be
   * backdated.
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
    await db
      .update(employments)
      .set({ startedAt: new Date("2025-01-06T08:00:00Z") })
      .where(eq(employments.organizationId, organizationId));
    await db.insert(organizationUsers).values({
      id: generateRandomUUID(),
      organizationId,
      userId: dana.id,
      grantedByUserId: owner.id,
    });
    await upsertSubscription(organizationId, {
      plan: subscriptionPlan.Enterprise,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });
    await db.transaction((tx) =>
      enableDirectory({ organizationId, userId: owner.id, agreementVersion: 1 }, tx)
    );
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
      settings: `/api/directory/${organizationId}/settings/retention`,
    };
  };

  const as = async (userId: string) => {
    const cookie = await authCookieFor(userId);
    return {
      get: (path: string) => request(server.url).get(path).set("Cookie", cookie),
      patch: (path: string, body: object) =>
        request(server.url).patch(path).set("Cookie", cookie).send(body),
      put: (path: string, body: object) =>
        request(server.url).put(path).set("Cookie", cookie).send(body),
      post: (path: string, body: object = {}) =>
        request(server.url).post(path).set("Cookie", cookie).send(body),
    };
  };
  type Client = Awaited<ReturnType<typeof as>>;

  const code = (res: request.Response) => res.body.errors?.[0]?.context?.code;

  /** A store URL points at the configured API origin; send it to the test server instead. */
  const local = (url: string) => {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  };

  const uploadPhoto = async (client: Client, organizationId: string, employmentId: string) => {
    const bytes = await sharp({
      create: { width: 600, height: 400, channels: 3, background: "#2f6f4f" },
    })
      .jpeg()
      .toBuffer();
    const requested = await client.post(
      `/api/directory/${organizationId}/people/${employmentId}/photo`,
      { contentType: "image/jpeg", size: bytes.length }
    );
    expect(requested.status).toBe(201);
    const target = requested.body.upload as { url: string; headers: Record<string, string> };
    const sent = await request(server.url).put(local(target.url)).set(target.headers).send(bytes);
    expect(sent.status).toBeLessThan(300);
    return requested.body.photo.id as string;
  };

  const photoFiles = async (organizationId: string, employmentId: string, photoId: string) => {
    const prefix = `photos/${organizationId}/${employmentId}/${photoId}/`;
    return {
      small: await organizationDataStore!.getObject(`${prefix}small.jpg`),
      full: await organizationDataStore!.getObject(`${prefix}full.jpg`),
    };
  };

  /** Fills every Section of a record, the photo included, as the owner. */
  const fill = async (fixture: Awaited<ReturnType<typeof setUp>>, employmentId: string) => {
    const owner = await as(fixture.users.owner.id);
    const saved = await owner.patch(fixture.path(employmentId), {
      ...FILLED,
      job: { ...FILLED.job, employeeNumber: `E-${employmentId.slice(0, 6)}` },
    });
    expect(saved.status).toBe(200);
    return uploadPhoto(owner, fixture.organizationId, employmentId);
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
    const photos = await db
      .select()
      .from(directoryPhotos)
      .where(eq(directoryPhotos.employmentId, employmentId));
    return { profile, sensitive, photos };
  };

  const retentionHistory = (employmentId: string) =>
    db
      .select({
        section: directoryProfileHistory.section,
        actor: directoryProfileHistory.actor,
        actorUserId: directoryProfileHistory.actorUserId,
        audience: directoryProfileHistory.audience,
        fields: directoryProfileHistory.fields,
      })
      .from(directoryProfileHistory)
      .where(
        and(
          eq(directoryProfileHistory.employmentId, employmentId),
          eq(directoryProfileHistory.actor, "RETENTION")
        )
      );

  describe("the nightly purge", () => {
    it("empties each Section once its period has passed, and a second run changes nothing", async () => {
      const fixture = await setUp();
      const { employment, users, organizationId } = fixture;
      const photoId = await fill(fixture, employment.jana);
      expect((await end(users.owner.id, employment.jana)).status).toBe(200);
      const [before] = await db
        .select()
        .from(employments)
        .where(eq(employments.id, employment.jana));

      await purgeRetention(later(29));
      expect(await retentionHistory(employment.jana)).toEqual([]);
      expect((await stored(employment.jana)).sensitive?.contact).not.toBeNull();

      await purgeRetention(later(31));
      const afterMonth = await stored(employment.jana);
      expect(afterMonth.profile).toMatchObject({
        workEmail: null,
        workPhone: null,
        jobTitle: "Accountant",
        legalName: "Jana Nováková",
        employeeNumber: `E-${employment.jana.slice(0, 6)}`,
      });
      expect(afterMonth.sensitive?.contact).toBeNull();
      expect(afterMonth.sensitive?.personal).not.toBeNull();
      expect(afterMonth.photos).toHaveLength(1);
      expect(await retentionHistory(employment.jana)).toEqual(
        expect.arrayContaining([
          {
            section: "WORK_CONTACT",
            actor: "RETENTION",
            actorUserId: null,
            audience: null,
            fields: ["workEmail", "workPhone"],
          },
          {
            section: "CONTACT",
            actor: "RETENTION",
            actorUserId: null,
            audience: null,
            fields: ["privatePhone", "privateEmail", "emergencyContact1", "emergencyContact2"],
          },
        ])
      );

      await purgeRetention(later(31));
      expect(await retentionHistory(employment.jana)).toHaveLength(2);

      await purgeRetention(later(367));
      expect((await stored(employment.jana)).photos).toEqual([]);
      expect(await photoFiles(organizationId, employment.jana, photoId)).toEqual({
        small: undefined,
        full: undefined,
      });
      expect((await stored(employment.jana)).sensitive?.personal).not.toBeNull();

      await purgeRetention(later(3 * 366));
      await purgeRetention(later(3 * 366));
      const afterYears = await stored(employment.jana);
      expect(afterYears.sensitive).toMatchObject({ contact: null, personal: null });
      expect(afterYears.profile).toMatchObject({
        jobTitle: "Accountant",
        legalName: "Jana Nováková",
      });
      expect((await retentionHistory(employment.jana)).map((row) => row.section).sort()).toEqual([
        "CONTACT",
        "PERSONAL",
        "PHOTO",
        "WORK_CONTACT",
      ]);

      const [after] = await db
        .select()
        .from(employments)
        .where(eq(employments.id, employment.jana));
      expect(after).toEqual(before);
    });

    it("starts the clock when a backdated ending is recorded, so nothing goes on the spot", async () => {
      const fixture = await setUp();
      const { employment, users } = fixture;
      await fill(fixture, employment.jana);
      expect((await end(users.owner.id, employment.jana, isoDay(later(-90)))).status).toBe(200);

      expect(await purgeRetention()).toBe(0);
      await purgeRetention(later(29));
      expect((await stored(employment.jana)).sensitive?.contact).not.toBeNull();
      expect(await retentionHistory(employment.jana)).toEqual([]);

      await purgeRetention(later(31));
      expect((await stored(employment.jana)).sensitive?.contact).toBeNull();
    });

    it("leaves open Employments alone, whatever their Sections hold", async () => {
      const fixture = await setUp();
      await fill(fixture, fixture.employment.mira);

      expect(await purgeRetention(later(20 * 366))).toBe(0);
      expect((await stored(fixture.employment.mira)).sensitive?.contact).not.toBeNull();
    });
  });

  describe("at end", () => {
    it("empties an at-end Section inside the End transaction, and the End dialog names it first", async () => {
      const fixture = await setUp();
      const { employment, users, organizationId, settings, path } = fixture;
      const photoId = await fill(fixture, employment.jana);
      const owner = await as(users.owner.id);
      await owner.put(settings, { section: "CONTACT", period: "AT_END" });
      await owner.put(settings, { section: "PHOTO", period: "AT_END" });
      await owner.put(settings, { section: "JOB", period: "AT_END" });
      await owner.patch(path(employment.jana), {
        job: { legalName: null, contractType: null, employeeNumber: null },
      });

      const preview = await owner.get(`${path(employment.jana)}/end-preview`);
      expect(preview.body.atEndSections).toEqual(["PHOTO", "CONTACT"]);

      expect((await end(users.owner.id, employment.jana, isoDay(later(-40)))).status).toBe(200);
      const after = await stored(employment.jana);
      expect(after.sensitive).toMatchObject({ contact: null });
      expect(after.sensitive?.personal).not.toBeNull();
      expect(after.photos).toEqual([]);
      expect(after.profile).toMatchObject({ workEmail: "jana@work.test" });
      expect(await photoFiles(organizationId, employment.jana, photoId)).toEqual({
        small: undefined,
        full: undefined,
      });
      expect((await retentionHistory(employment.jana)).map((row) => row.section).sort()).toEqual([
        "CONTACT",
        "PHOTO",
      ]);

      expect(await purgeRetention()).toBe(0);
    });

    it("lets the nightly run catch an Employment that ended before its Section became at end", async () => {
      const fixture = await setUp();
      const { employment, users, settings } = fixture;
      await fill(fixture, employment.jana);
      await end(users.owner.id, employment.jana);
      await (await as(users.owner.id)).put(settings, { section: "PERSONAL", period: "AT_END" });

      expect(await purgeRetention(later(1))).toBe(1);
      expect((await stored(employment.jana)).sensitive?.personal).toBeNull();
    });
  });

  describe("whatever the directory and the plan", () => {
    it("keeps purging while the directory is off and the plan has lapsed", async () => {
      const fixture = await setUp();
      const { employment, users, organizationId } = fixture;
      await fill(fixture, employment.jana);
      await end(users.owner.id, employment.jana);
      await upsertSubscription(organizationId, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });
      await db.transaction((tx) =>
        disableDirectory({ organizationId, userId: users.owner.id }, tx)
      );

      await runRetentionPurge(later(31));
      expect((await stored(employment.jana)).sensitive?.contact).toBeNull();
      expect((await stored(employment.jana)).profile).toMatchObject({ workEmail: null });
    });

    it("shows a purge in the Profile history as retention, with no person and no values", async () => {
      const fixture = await setUp();
      const { employment, users, path } = fixture;
      await fill(fixture, employment.jana);
      await end(users.owner.id, employment.jana);
      await purgeRetention(later(31));

      const history = await (await as(users.hana.id)).get(`${path(employment.jana)}/history`);
      expect(history.status).toBe(200);
      const purges = (history.body as { actor: string }[]).filter(
        (entry) => entry.actor === "RETENTION"
      );
      expect(purges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ section: "CONTACT", actorName: null, audience: null }),
          expect.objectContaining({ section: "WORK_CONTACT", actorName: null, audience: null }),
        ])
      );
      expect(JSON.stringify(history.body)).not.toContain("jana@");
    });
  });

  describe("the Retention settings", () => {
    const DEFAULTS = {
      CARD: "UNTIL_ERASED",
      PHOTO: "YEAR_1",
      WORK_CONTACT: "DAYS_30",
      JOB: "UNTIL_ERASED",
      CONTACT: "DAYS_30",
      PERSONAL: "YEARS_3",
    };

    it("reads the defaults for the owner, org admins and HR, and only the first two change them", async () => {
      const { users, settings } = await setUp();

      const owner = await (await as(users.owner.id)).get(settings);
      expect(owner.status).toBe(200);
      expect(owner.body).toEqual({ editable: true, periods: DEFAULTS, defaults: DEFAULTS });
      const hr = await as(users.hana.id);
      expect((await hr.get(settings)).body).toMatchObject({ editable: false, periods: DEFAULTS });
      const refused = await hr.put(settings, { section: "CONTACT", period: "YEAR_1" });
      expect(refused.status).toBe(403);
      expect(code(refused)).toBe("SETTINGS_NOT_EDITABLE");
      const member = await (await as(users.mira.id)).get(settings);
      expect(member.status).toBe(403);
      expect(code(member)).toBe("SETTINGS_DENIED");

      const saved = await (
        await as(users.dana.id)
      ).put(settings, { section: "CONTACT", period: "MONTHS_6" });
      expect(saved.status).toBe(200);
      expect(saved.body.periods).toEqual({ ...DEFAULTS, CONTACT: "MONTHS_6" });
      expect((await hr.get(settings)).body.periods.CONTACT).toBe("MONTHS_6");
    });

    it("changes on a lapsed plan too, and refuses a period off the list", async () => {
      const { organizationId, users, settings } = await setUp();
      await upsertSubscription(organizationId, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });
      const owner = await as(users.owner.id);

      expect((await owner.put(settings, { section: "PHOTO", period: "UNTIL_ERASED" })).status).toBe(
        200
      );
      expect((await owner.put(settings, { section: "PHOTO", period: "YEARS_2" })).status).toBe(422);
      expect(
        (await owner.put(settings, { section: "END_EMPLOYMENT", period: "DAYS_30" })).status
      ).toBe(422);
    });

    it("applies a shortening to Employments that already ended, and a lengthening brings nothing back", async () => {
      const fixture = await setUp();
      const { employment, users, settings } = fixture;
      await fill(fixture, employment.jana);
      await end(users.owner.id, employment.jana);
      const owner = await as(users.owner.id);

      await owner.put(settings, { section: "PERSONAL", period: "DAYS_30" });
      await purgeRetention(later(31));
      expect((await stored(employment.jana)).sensitive?.personal).toBeNull();

      await owner.put(settings, { section: "PERSONAL", period: "YEARS_10" });
      expect((await stored(employment.jana)).sensitive?.personal).toBeNull();
    });

    it("counts the people a shorter period removes at the next nightly run", async () => {
      const fixture = await setUp();
      const { employment, users, settings } = fixture;
      await fill(fixture, employment.jana);
      await fill(fixture, employment.pavel);
      await fill(fixture, employment.mira);
      await end(users.owner.id, employment.jana, isoDay(later(-200)));
      await end(users.owner.id, employment.pavel, isoDay(later(-10)));
      await db
        .update(employments)
        .set({ endRecordedAt: later(-200) })
        .where(eq(employments.id, employment.jana));
      await db
        .update(employments)
        .set({ endRecordedAt: later(-10) })
        .where(eq(employments.id, employment.pavel));
      const owner = await as(users.owner.id);
      const preview = (period: string) =>
        owner.get(`${settings}/preview?section=PERSONAL&period=${period}`);

      expect((await preview("MONTHS_6")).body).toEqual({
        section: "PERSONAL",
        period: "MONTHS_6",
        affected: 1,
      });
      expect((await preview("AT_END")).body.affected).toBe(2);
      expect((await preview("YEARS_5")).body.affected).toBe(0);
      expect((await preview("NEVER")).status).toBe(422);
      const hr = await (
        await as(users.hana.id)
      ).get(`${settings}/preview?section=PERSONAL&period=AT_END`);
      expect(hr.status).toBe(403);
    });

    it("names the Contact period in the Art. 14 notice", async () => {
      const { employment, users, settings, path, organizationId } = await setUp();
      const owner = await as(users.owner.id);
      await owner.put(settings, { section: "CONTACT", period: "MONTHS_6" });

      const general = await owner.get(`/api/directory/${organizationId}/settings/general`);
      expect(general.body.period).toEqual({ en: "6 months", cs: "6 měsíců" });
      const profile = await owner.get(`${path(employment.jana)}?language=cs`);
      expect(profile.body.sections.contact.notice).toContain("6 měsíců");
    });
  });
});

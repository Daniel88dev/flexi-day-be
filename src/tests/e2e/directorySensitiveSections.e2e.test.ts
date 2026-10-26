import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import {
  directoryPermissionCells,
  directoryPermissionRow,
} from "../../db/schema/directory-schema.js";
import { directoryRoleAssignments, directoryRole } from "../../db/schema/directory-role-schema.js";
import { directorySensitiveProfiles } from "../../db/schema/directory-sensitive-profile-schema.js";
import { employments, workerType } from "../../db/schema/employment-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { readLog, readLogAudience, readLogKind } from "../../db/schema/read-log-schema.js";
import { runReadLogPurge } from "../../jobs/readLogPurgeJob.js";
import { rekeyOrganization } from "../../services/fieldEncryption/rekeyServices.js";
import { collectOrganizationExport } from "../../services/personExport/organizationExportData.js";
import { requestOrganizationExport } from "../../services/personExport/organizationExportServices.js";
import { collectPersonExport } from "../../services/personExport/personExportData.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { enableDirectory } from "../../services/directory/directorySettingsServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { addMember, makeGroup, makeUser } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

const CONTACT = {
  privatePhone: "+420 777 123 456",
  privateEmail: "Jana.Home@Example.TEST",
  emergencyContact1: { name: "Karel Novák", phone: "+420 602 111 222" },
  emergencyContact2: null,
};

const PERSONAL = {
  homeAddress: {
    line1: "Vinohradská 12",
    line2: null,
    postalCode: "120 00",
    city: "Praha",
    region: null,
    country: "CZ",
  },
  dateOfBirth: "1990-04-17",
};

describe("The Sensitive sections, Contact and Personal", () => {
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
   * Olga owns the organization and manages Support. In Support: Jana (the
   * person read), Pavel (plain colleague), Dana (org-admin grant), Hana (HR),
   * Gita (group admin) and Eli (External worker). Also one record without an
   * account.
   */
  const setUp = async () => {
    const owner = await makeUser("Olga Owner");
    const jana = await makeUser("Jana Member");
    const pavel = await makeUser("Pavel Colleague");
    const dana = await makeUser("Dana Delegate");
    const hana = await makeUser("Hana Human");
    const gita = await makeUser("Gita Groupadmin");
    const eli = await makeUser("Eli External");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    const support = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    await addMember(support, owner.id);
    await syncEmployment(organizationId, owner.id);
    for (const person of [jana, pavel, dana, hana, eli]) {
      await addMember(support, person.id);
      await syncEmployment(organizationId, person.id);
    }
    await addMember(support, gita.id, { adminAccess: true, controlledUser: false });
    await syncEmployment(organizationId, gita.id);
    await db.insert(organizationUsers).values({
      id: generateRandomUUID(),
      organizationId,
      userId: dana.id,
      grantedByUserId: owner.id,
    });
    await db
      .update(employments)
      .set({ type: workerType.External })
      .where(eq(employments.userId, eli.id));
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
    const accountless = generateRandomUUID();
    await db.insert(employments).values({
      id: accountless,
      organizationId,
      userId: null,
      name: "Nora Noaccount",
      email: "nora@example.test",
    });
    const janaEmployment = await employmentOf(jana.id);
    return {
      organizationId,
      users: { owner, jana, pavel, dana, hana, gita, eli },
      employment: {
        jana: janaEmployment,
        eli: await employmentOf(eli.id),
        accountless,
      },
      path: (employmentId: string) => `/api/directory/${organizationId}/people/${employmentId}`,
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

  const code = (res: request.Response) => res.body.errors?.[0]?.context?.code;

  const setCell = async (organizationId: string, row: string, audience: string, value: string) =>
    db
      .update(directoryPermissionCells)
      .set({ value: value as never })
      .where(
        and(
          eq(directoryPermissionCells.organizationId, organizationId),
          eq(directoryPermissionCells.row, row as never),
          eq(directoryPermissionCells.audience, audience as never)
        )
      );

  const logRows = (organizationId: string) =>
    db.select().from(readLog).where(eq(readLog.organizationId, organizationId));

  const fill = async (path: string, ownerId: string) => {
    const res = await (await as(ownerId)).patch(path, { contact: CONTACT, personal: PERSONAL });
    expect(res.status).toBe(200);
    return res;
  };

  describe("Show", () => {
    it("writes no read-log row when the profile or the edit form opens, and one per Show", async () => {
      const { organizationId, users, employment, path } = await setUp();
      const saved = await fill(path(employment.jana), users.owner.id);
      const owner = await as(users.owner.id);

      const profile = await owner.get(path(employment.jana));
      expect(profile.body.sections.contact).toEqual(
        expect.objectContaining({ level: "WRITE", notice: expect.any(String) })
      );
      expect(profile.body.sections.personal).toEqual({ level: "WRITE" });
      for (const body of [JSON.stringify(saved.body), JSON.stringify(profile.body)]) {
        expect(body).not.toContain("777");
        expect(body).not.toContain("jana.home");
        expect(body).not.toContain("Vinohradsk");
        expect(body).not.toContain("1990-04-17");
      }
      expect(await logRows(organizationId)).toEqual([]);

      const contact = await owner.post(`${path(employment.jana)}/show/contact`);
      expect(contact.status).toBe(200);
      expect(contact.body).toEqual({
        section: "CONTACT",
        level: "WRITE",
        recorded: true,
        privatePhone: {
          e164: "+420777123456",
          display: "+420 777 123 456",
          country: { code: "CZ", name: "Czechia" },
        },
        privateEmail: "jana.home@example.test",
        emergencyContact1: {
          name: "Karel Novák",
          phone: {
            e164: "+420602111222",
            display: "+420 602 111 222",
            country: { code: "CZ", name: "Czechia" },
          },
        },
        emergencyContact2: null,
      });

      const rows = await logRows(organizationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "read",
        readerUserId: users.owner.id,
        subjectUserId: users.jana.id,
        employmentIds: [employment.jana],
        sections: ["CONTACT"],
        audience: "OWNER",
      });
      expect(JSON.stringify(rows[0])).not.toContain("777");

      const personal = await owner.post(`${path(employment.jana)}/show/personal`);
      expect(personal.body).toEqual({
        section: "PERSONAL",
        level: "WRITE",
        recorded: true,
        homeAddress: {
          line1: "Vinohradská 12",
          line2: null,
          postalCode: "120 00",
          city: "Praha",
          region: null,
          country: { code: "CZ", name: "Czechia" },
        },
        dateOfBirth: "1990-04-17",
      });
      expect(await logRows(organizationId)).toHaveLength(2);
    });

    it("logs the Audience that granted each read, and refuses readers without a cell", async () => {
      const { organizationId, users, employment, path } = await setUp();
      await fill(path(employment.jana), users.owner.id);
      const show = `${path(employment.jana)}/show/contact`;

      expect((await (await as(users.dana.id)).post(show)).status).toBe(200);
      expect((await (await as(users.hana.id)).post(show)).status).toBe(200);
      const colleague = await (await as(users.pavel.id)).post(show);
      expect(colleague.status).toBe(403);
      expect(code(colleague)).toBe("SECTION_NOT_READABLE");
      const groupAdmin = await (await as(users.gita.id)).post(show);
      expect(groupAdmin.status).toBe(403);

      await setCell(organizationId, "CONTACT", "GROUP_ADMIN", "READ");
      const opened = await (await as(users.gita.id)).post(show);
      expect(opened.status).toBe(200);
      expect(opened.body).toMatchObject({ level: "READ", recorded: true });

      const rows = await logRows(organizationId);
      expect(rows.map((row) => [row.readerUserId, row.audience]).sort()).toEqual(
        [
          [users.dana.id, "ORGANIZATION_ADMIN"],
          [users.hana.id, "HR"],
          [users.gita.id, "GROUP_ADMIN"],
        ].sort()
      );
    });

    it("never logs the person reading their own record", async () => {
      const { organizationId, users, employment, path } = await setUp();
      await fill(path(employment.jana), users.owner.id);
      const jana = await as(users.jana.id);

      const contact = await jana.post(`${path(employment.jana)}/show/contact`);
      const personal = await jana.post(`${path(employment.jana)}/show/personal`);

      expect(contact.body).toMatchObject({ level: "WRITE", recorded: false });
      expect(personal.body).toMatchObject({ recorded: false, dateOfBirth: "1990-04-17" });
      expect(await logRows(organizationId)).toEqual([]);
    });

    it("logs a read of a record without an account by its Employment", async () => {
      const { organizationId, users, employment, path } = await setUp();
      await (
        await as(users.owner.id)
      ).patch(path(employment.accountless), { contact: { privateEmail: "nora@home.test" } });

      const shown = await (
        await as(users.hana.id)
      ).post(`${path(employment.accountless)}/show/contact`);

      expect(shown.body.privateEmail).toBe("nora@home.test");
      const [row] = await logRows(organizationId);
      expect(row).toMatchObject({
        subjectUserId: null,
        employmentIds: [employment.accountless],
        audience: "HR",
      });
    });

    it("answers 404 for a record out of reach and for another Section name", async () => {
      const { users, employment, path } = await setUp();
      const outsider = await makeUser("Xena Outsider");

      expect(
        (await (await as(outsider.id)).post(`${path(employment.jana)}/show/contact`)).status
      ).toBe(403);
      const job = await (await as(users.owner.id)).post(`${path(employment.jana)}/show/job`);
      expect(job.status).toBe(404);
      expect(code(job)).toBe("SECTION_NOT_FOUND");
    });
  });

  describe("on External workers' records", () => {
    it("leaves Personal off the profile and refuses to show or write it", async () => {
      const { users, employment, path } = await setUp();
      const owner = await as(users.owner.id);

      const profile = await owner.get(path(employment.eli));
      expect(profile.body.sections).toHaveProperty("contact");
      expect(profile.body.sections).not.toHaveProperty("personal");

      const shown = await owner.post(`${path(employment.eli)}/show/personal`);
      expect(shown.status).toBe(422);
      expect(code(shown)).toBe("EMPLOYEES_ONLY");

      const written = await owner.patch(path(employment.eli), { personal: PERSONAL });
      expect(written.status).toBe(422);
      expect(code(written)).toBe("EMPLOYEES_ONLY");

      const contact = await owner.patch(path(employment.eli), { contact: CONTACT });
      expect(contact.status).toBe(200);
    });
  });

  describe("writing", () => {
    it("stores both Sections sealed, with nothing readable in the row", async () => {
      const { users, employment, path } = await setUp();
      await fill(path(employment.jana), users.owner.id);

      const [stored] = await db
        .select()
        .from(directorySensitiveProfiles)
        .where(eq(directorySensitiveProfiles.employmentId, employment.jana));
      expect(stored!.contact).toMatch(/^fe1:1:/);
      expect(stored!.personal).toMatch(/^fe1:1:/);
      const raw = JSON.stringify(stored);
      for (const plain of ["777", "jana.home", "Karel", "Vinohradsk", "1990"]) {
        expect(raw).not.toContain(plain);
      }
    });

    it("lets the person write their own Contact and Personal, and keeps a colleague out", async () => {
      const { users, employment, path } = await setUp();

      const own = await (
        await as(users.jana.id)
      ).patch(path(employment.jana), {
        contact: { privatePhone: "+420 777 123 456" },
        personal: { dateOfBirth: "1991-01-02" },
      });
      expect(own.status).toBe(200);

      const colleague = await (
        await as(users.pavel.id)
      ).patch(path(employment.jana), {
        contact: { privatePhone: "+420 777 000 000" },
      });
      expect(colleague.status).toBe(403);
      expect(code(colleague)).toBe("SECTION_NOT_WRITABLE");
    });

    it("refuses invalid phones, countries, dates of birth and half-filled emergency contacts", async () => {
      const { users, employment, path } = await setUp();
      const owner = await as(users.owner.id);
      const target = path(employment.jana);

      const bodies: [object, string | undefined][] = [
        [{ contact: { privatePhone: "+420 777 12" } }, "INVALID_PHONE"],
        [
          { contact: { emergencyContact2: { name: "Ema", phone: "777 123 456" } } },
          "INVALID_PHONE",
        ],
        [{ contact: { emergencyContact1: { name: "Ema" } } }, undefined],
        [{ contact: { emergencyContact1: { phone: "+420 602 111 222" } } }, undefined],
        [{ contact: { privateEmail: "not an email" } }, undefined],
        [
          { personal: { homeAddress: { ...PERSONAL.homeAddress, country: "QQ" } } },
          "INVALID_COUNTRY",
        ],
        [{ personal: { homeAddress: { line1: "Vinohradská 12", country: "CZ" } } }, undefined],
        [
          { personal: { homeAddress: { ...PERSONAL.homeAddress, postalCode: "1".repeat(17) } } },
          undefined,
        ],
        [{ personal: { dateOfBirth: "1899-12-31" } }, "DATE_OF_BIRTH_OUT_OF_RANGE"],
        [{ personal: { dateOfBirth: "2999-01-01" } }, "DATE_OF_BIRTH_OUT_OF_RANGE"],
      ];
      for (const [body, expected] of bodies) {
        const res = await owner.patch(target, body);
        expect(res.status, JSON.stringify(body)).toBe(422);
        if (expected) expect(code(res)).toBe(expected);
      }
      expect(
        await db
          .select()
          .from(directorySensitiveProfiles)
          .where(eq(directorySensitiveProfiles.employmentId, employment.jana))
      ).toEqual([]);
    });

    it("records which fields changed in the profile history, never the values", async () => {
      const { users, employment, path } = await setUp();
      const owner = await as(users.owner.id);
      await fill(path(employment.jana), users.owner.id);
      await owner.patch(path(employment.jana), {
        contact: { emergencyContact2: { name: "Ema", phone: "+420 603 333 444" } },
      });

      const history = await owner.get(`${path(employment.jana)}/history`);

      expect(
        history.body.map((entry: { section: string; fields: string[] }) => [
          entry.section,
          entry.fields,
        ])
      ).toEqual(
        expect.arrayContaining([
          ["CONTACT", ["emergencyContact2"]],
          ["CONTACT", ["privatePhone", "privateEmail", "emergencyContact1"]],
          ["PERSONAL", ["homeAddress", "dateOfBirth"]],
        ])
      );
      expect(JSON.stringify(history.body)).not.toContain("603");
    });

    it("needs the directory plan to set a value, and clears on any plan", async () => {
      const { organizationId, users, employment, path } = await setUp();
      await fill(path(employment.jana), users.owner.id);
      await upsertSubscription(organizationId, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });
      const owner = await as(users.owner.id);

      const set = await owner.patch(path(employment.jana), {
        contact: { privateEmail: "x@y.test" },
      });
      expect(set.status).toBe(402);
      const cleared = await owner.patch(path(employment.jana), {
        contact: { privatePhone: null, privateEmail: null, emergencyContact1: null },
        personal: { homeAddress: null, dateOfBirth: null },
      });
      expect(cleared.status).toBe(200);

      const [stored] = await db
        .select()
        .from(directorySensitiveProfiles)
        .where(eq(directorySensitiveProfiles.employmentId, employment.jana));
      expect(stored).toMatchObject({ contact: null, personal: null });
      const shown = await owner.post(`${path(employment.jana)}/show/contact`);
      expect(shown.body).toMatchObject({ privatePhone: null, emergencyContact1: null });
    });
  });

  describe("the read log page", () => {
    it("lists reads and exports for the owner and org admins, with names and no values", async () => {
      const { organizationId, users, employment, path } = await setUp();
      await fill(path(employment.jana), users.owner.id);
      await (await as(users.hana.id)).post(`${path(employment.jana)}/show/contact`);
      await (await as(users.dana.id)).post(`${path(employment.jana)}/show/personal`);
      await (await as(users.owner.id)).post(`/api/employment/${employment.jana}/export`);
      const logPath = `/api/directory/${organizationId}/read-log`;

      const res = await (await as(users.dana.id)).get(logPath);

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(3);
      expect(res.body.entries[0]).toMatchObject({
        kind: "export",
        reader: { userId: users.owner.id, name: "Olga Owner" },
        person: { employmentId: employment.jana, name: "Jana Member" },
        sections: null,
        audience: "OWNER",
      });
      expect(res.body.entries[2]).toMatchObject({
        kind: "read",
        reader: { userId: users.hana.id, name: "Hana Human" },
        person: { employmentId: employment.jana, name: "Jana Member" },
        sections: ["CONTACT"],
        audience: "HR",
      });
      expect(res.body.readers.map((reader: { name: string }) => reader.name)).toEqual([
        "Dana Delegate",
        "Hana Human",
        "Olga Owner",
      ]);
      expect(res.body.people).toEqual([{ employmentId: employment.jana, name: "Jana Member" }]);
      expect(JSON.stringify(res.body)).not.toContain("777");
      expect((await (await as(users.owner.id)).get(logPath)).status).toBe(200);
    });

    it("filters by person and by reader", async () => {
      const { organizationId, users, employment, path } = await setUp();
      await fill(path(employment.jana), users.owner.id);
      await (await as(users.hana.id)).post(`${path(employment.jana)}/show/contact`);
      await (await as(users.hana.id)).post(`${path(employment.accountless)}/show/contact`);
      await (await as(users.dana.id)).post(`${path(employment.accountless)}/show/contact`);
      const logPath = `/api/directory/${organizationId}/read-log`;
      const owner = await as(users.owner.id);

      const byPerson = await owner.get(`${logPath}?employmentId=${employment.accountless}`);
      expect(
        byPerson.body.entries.map((entry: { person: { name: string } }) => entry.person.name)
      ).toEqual(["Nora Noaccount", "Nora Noaccount"]);

      const byReader = await owner.get(`${logPath}?readerUserId=${users.hana.id}`);
      expect(
        byReader.body.entries.map((entry: { person: { name: string } }) => entry.person.name)
      ).toEqual(["Nora Noaccount", "Jana Member"]);

      const both = await owner.get(
        `${logPath}?readerUserId=${users.dana.id}&employmentId=${employment.jana}`
      );
      expect(both.body.entries).toEqual([]);
    });

    it("is closed to HR, group admins and colleagues", async () => {
      const { organizationId, users } = await setUp();
      const logPath = `/api/directory/${organizationId}/read-log`;

      for (const reader of [users.hana, users.gita, users.pavel]) {
        const res = await (await as(reader.id)).get(logPath);
        expect(res.status).toBe(403);
        expect(code(res)).toBe("READ_LOG_DENIED");
      }
    });

    it("pages from the newest row back", async () => {
      const { organizationId, users, employment, path } = await setUp();
      for (let index = 0; index < 3; index += 1) {
        await (await as(users.hana.id)).post(`${path(employment.jana)}/show/contact`);
      }
      const owner = await as(users.owner.id);
      const logPath = `/api/directory/${organizationId}/read-log`;

      const first = await owner.get(`${logPath}?limit=2`);
      expect(first.body.entries).toHaveLength(2);
      expect(first.body.nextBefore).toEqual(expect.any(String));
      const second = await owner.get(`${logPath}?limit=2&before=${first.body.nextBefore}`);
      expect(second.body.entries).toHaveLength(1);
      expect(second.body.nextBefore).toBeNull();
      const ids = [...first.body.entries, ...second.body.entries].map(
        (entry: { id: string }) => entry.id
      );
      expect(new Set(ids).size).toBe(3);
    });
  });

  describe("read-log retention", () => {
    it("removes rows older than 12 months on the nightly step and keeps the rest", async () => {
      const { organizationId, users, employment } = await setUp();
      const now = new Date("2026-10-26T02:00:00Z");
      const row = (id: string, createdAt: Date) => ({
        id,
        organizationId,
        kind: readLogKind.Read,
        readerUserId: users.hana.id,
        subjectUserId: users.jana.id,
        employmentIds: [employment.jana],
        sections: [directoryPermissionRow.Contact],
        audience: readLogAudience.Hr,
        createdAt,
      });
      await db
        .insert(readLog)
        .values([
          row("old", new Date("2025-10-25T23:00:00Z")),
          row("edge", new Date("2025-10-26T03:00:00Z")),
          row("new", new Date("2026-10-01T00:00:00Z")),
        ]);

      await runReadLogPurge(now);
      await runReadLogPurge(now);

      const left = await logRows(organizationId);
      expect(left.map((entry) => entry.id).sort()).toEqual(["edge", "new"]);
    });

    it("keeps a person's rows after their erasure, until their 12 months run out", async () => {
      const { organizationId, users, employment, path } = await setUp();
      await fill(path(employment.accountless), users.owner.id);
      await (await as(users.hana.id)).post(`${path(employment.accountless)}/show/contact`);

      await db.delete(employments).where(eq(employments.id, employment.accountless));

      expect(
        await db
          .select()
          .from(directorySensitiveProfiles)
          .where(eq(directorySensitiveProfiles.employmentId, employment.accountless))
      ).toEqual([]);
      const page = await (
        await as(users.owner.id)
      ).get(`/api/directory/${organizationId}/read-log`);
      expect(page.body.entries).toHaveLength(1);
      expect(page.body.entries[0].person).toEqual({
        employmentId: employment.accountless,
        name: null,
      });
    });
  });

  describe("exports, Erase and re-key", () => {
    it("puts the values and the read dates and purposes into the Person export, without reader names", async () => {
      const { organizationId, users, employment, path } = await setUp();
      await fill(path(employment.jana), users.owner.id);
      await (await as(users.hana.id)).post(`${path(employment.jana)}/show/contact`);
      await (await as(users.dana.id)).post(`${path(employment.jana)}/show/personal`);

      const { person } = await collectPersonExport(organizationId, users.jana.id);

      expect(person.employments[0]).toMatchObject({
        contact: {
          privatePhone: "+420777123456",
          privateEmail: "jana.home@example.test",
          emergencyContact1: { name: "Karel Novák", phone: "+420602111222" },
          emergencyContact2: null,
        },
        personal: PERSONAL,
      });
      expect(person.readLog).toEqual([
        { at: expect.any(Date), kind: "read", sections: ["CONTACT"], purpose: "HR administration" },
        {
          at: expect.any(Date),
          kind: "read",
          sections: ["PERSONAL"],
          purpose: "organization administration",
        },
      ]);
      const readLogJson = JSON.stringify(person.readLog);
      for (const reader of ["Hana", "Dana", users.hana.id, users.dana.id]) {
        expect(readLogJson).not.toContain(reader);
      }
    });

    it("puts a person without an account's values and reads into the Organization export", async () => {
      const { organizationId, users, employment, path } = await setUp();
      await (
        await as(users.owner.id)
      ).patch(path(employment.accountless), { contact: { privateEmail: "nora@home.test" } });
      await (await as(users.hana.id)).post(`${path(employment.accountless)}/show/contact`);
      await db.transaction((tx) =>
        requestOrganizationExport({ organizationId, requestedByUserId: users.owner.id }, tx)
      );

      const { document } = await collectOrganizationExport(organizationId);

      const nora = document.peopleWithoutAccount.find(
        (entry) => entry.employmentId === employment.accountless
      );
      expect(nora).toMatchObject({
        contact: { privateEmail: "nora@home.test" },
        personal: null,
        readLog: [
          { kind: "read", sections: ["CONTACT"], purpose: "HR administration" },
          { kind: "export", sections: null, purpose: "owner" },
        ],
      });
    });

    it("goes with Erase", async () => {
      const { users, employment, path } = await setUp();
      await fill(path(employment.jana), users.owner.id);

      await db.delete(employments).where(eq(employments.id, employment.jana));

      expect(
        await db
          .select()
          .from(directorySensitiveProfiles)
          .where(eq(directorySensitiveProfiles.employmentId, employment.jana))
      ).toEqual([]);
    });

    it("is re-encrypted by a re-key and reads back the same", async () => {
      const { organizationId, users, employment, path } = await setUp();
      await fill(path(employment.jana), users.owner.id);

      const result = await rekeyOrganization(organizationId);

      expect(result).toMatchObject({ version: 2, values: 2 });
      const [stored] = await db
        .select()
        .from(directorySensitiveProfiles)
        .where(eq(directorySensitiveProfiles.employmentId, employment.jana));
      expect(stored!.contact).toMatch(/^fe1:2:/);
      const shown = await (await as(users.owner.id)).post(`${path(employment.jana)}/show/personal`);
      expect(shown.body.dateOfBirth).toBe("1990-04-17");
    });
  });

  describe("the Art. 14 notice", () => {
    it("shows the default to whoever edits emergency contacts, and the organization's own text once set", async () => {
      const { organizationId, users, employment, path } = await setUp();
      const general = `/api/directory/${organizationId}/settings/general`;
      const owner = await as(users.owner.id);

      const defaults = await owner.get(general);
      expect(defaults.body).toMatchObject({
        editable: true,
        emergencyContactNotice: { en: null, cs: null },
        defaults: {
          en: expect.stringContaining("{period}"),
          cs: expect.stringContaining("{period}"),
        },
        period: { en: "30 days", cs: "30 dní" },
      });
      const shown = await owner.get(`${path(employment.jana)}?language=en`);
      expect(shown.body.sections.contact.notice).toContain("for 30 days after you leave");
      expect(shown.body.sections.contact.notice).not.toContain("{");

      const saved = await (
        await as(users.dana.id)
      ).put(general, {
        emergencyContactNotice: { en: "{organization} keeps them for {period}.", cs: null },
      });
      expect(saved.status).toBe(200);
      expect(saved.body.emergencyContactNotice.en).toBe("{organization} keeps them for {period}.");

      const own = await (await as(users.jana.id)).get(`${path(employment.jana)}?language=en`);
      expect(own.body.sections.contact.notice).toMatch(/ keeps them for 30 days\.$/);
      const czech = await (await as(users.jana.id)).get(`${path(employment.jana)}?language=cs`);
      expect(czech.body.sections.contact.notice).toContain("30 dní po vašem odchodu");
      const reader = await (await as(users.dana.id)).get(path(employment.jana));
      expect(reader.body.sections.contact).toHaveProperty("notice");

      await setCell(organizationId, "CONTACT", "HR", "READ");
      const hrView = await (await as(users.hana.id)).get(path(employment.jana));
      expect(hrView.body.sections.contact).toEqual({ level: "READ" });
    });

    it("lets HR read the texts and only the owner and org admins change them", async () => {
      const { organizationId, users } = await setUp();
      const general = `/api/directory/${organizationId}/settings/general`;

      const hr = await as(users.hana.id);
      expect((await hr.get(general)).body.editable).toBe(false);
      const refused = await hr.put(general, { emergencyContactNotice: { en: "x" } });
      expect(refused.status).toBe(403);
      expect(code(refused)).toBe("SETTINGS_NOT_EDITABLE");
      expect((await (await as(users.pavel.id)).get(general)).status).toBe(403);

      const tooLong = await (
        await as(users.owner.id)
      ).put(general, { emergencyContactNotice: { en: "x".repeat(2001) } });
      expect(tooLong.status).toBe(422);
    });
  });
});

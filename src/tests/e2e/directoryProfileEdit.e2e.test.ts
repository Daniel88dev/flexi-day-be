import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import { directoryProfileHistory } from "../../db/schema/directory-profile-schema.js";
import { directoryPermissionCells } from "../../db/schema/directory-schema.js";
import { employments, workerType } from "../../db/schema/employment-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { getPersonContacts } from "../../services/person/personName.js";
import { collectOrganizationExport } from "../../services/personExport/organizationExportData.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { addMember, makeGroup, makeUser } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { apiAs, enableEnterpriseDirectory, errorCode as code } from "./helpers/directoryWorld.js";

describe("Editing the Card and Job Sections of a Profile", () => {
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
   * Olga owns the organization and manages Support. In Support: Jana (plain
   * member), Gabi (member with admin access, a Group admin), Dana (org-admin
   * grant), Eli (External worker), Karel (Deleted account, still open) and
   * Petra (left). Ada has no account.
   */
  const setUp = async () => {
    const owner = await makeUser("Olga Owner");
    const jana = await makeUser("Jana Member");
    const gabi = await makeUser("Gabi Groupadmin");
    const dana = await makeUser("Dana Delegate");
    const eli = await makeUser("Eli External");
    const karel = await makeUser("Karel Deleted");
    const petra = await makeUser("Petra Leaver");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    const support = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    await addMember(support, owner.id);
    await syncEmployment(organizationId, owner.id);
    for (const person of [jana, gabi, dana, eli, karel, petra]) {
      await addMember(support, person.id, { adminAccess: person === gabi });
      await syncEmployment(organizationId, person.id);
    }
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
    await db
      .update(employments)
      .set({ accountDeletedAt: new Date("2026-09-01T10:00:00Z") })
      .where(eq(employments.userId, karel.id));
    await db
      .update(employments)
      .set({ endedAt: new Date("2026-03-31T12:00:00Z") })
      .where(eq(employments.userId, petra.id));
    const ada = uuidv4();
    await db.insert(employments).values({
      id: ada,
      organizationId,
      userId: null,
      name: "Ada Noaccount",
      email: "ada@example.test",
    });

    await enableEnterpriseDirectory(organizationId, owner.id);

    const employmentOf = async (userId: string) => {
      const [row] = await db
        .select({ id: employments.id })
        .from(employments)
        .where(and(eq(employments.userId, userId), eq(employments.organizationId, organizationId)));
      return row!.id;
    };

    return {
      organizationId,
      users: { owner, jana, gabi, dana, eli, karel, petra },
      employment: {
        owner: await employmentOf(owner.id),
        jana: await employmentOf(jana.id),
        gabi: await employmentOf(gabi.id),
        dana: await employmentOf(dana.id),
        eli: await employmentOf(eli.id),
        karel: await employmentOf(karel.id),
        petra: await employmentOf(petra.id),
        ada,
      },
    };
  };

  const as = (userId: string) => apiAs(server.url, userId);

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

  const lapse = (organizationId: string) =>
    upsertSubscription(organizationId, {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });

  describe("write cells", () => {
    it("saves a job title an org admin sets, and every Card reader sees it", async () => {
      const { organizationId, users, employment } = await setUp();
      const dana = await as(users.dana.id);
      const path = `/api/directory/${organizationId}/people/${employment.jana}`;

      const res = await dana.patch(path, { card: { jobTitle: "  Support specialist " } });

      expect(res.status).toBe(200);
      expect(res.body.sections.card.jobTitle).toBe("Support specialist");
      const jana = await as(users.jana.id);
      expect((await jana.get(path)).body.sections.card.jobTitle).toBe("Support specialist");
      const list = await jana.get(`/api/directory/${organizationId}/people`);
      const row = list.body.people.find(
        (person: { employmentId: string }) => person.employmentId === employment.jana
      );
      expect(row.jobTitle).toBe("Support specialist");
    });

    it("refuses a viewer whose cell only reads, and one who can't read the Section at all", async () => {
      const { organizationId, users, employment } = await setUp();
      const path = `/api/directory/${organizationId}/people/${employment.jana}`;

      const colleague = await (await as(users.eli.id)).patch(path, { card: { jobTitle: "Boss" } });
      expect(colleague.status).toBe(403);
      expect(code(colleague)).toBe("SECTION_NOT_WRITABLE");

      const self = await (await as(users.jana.id)).patch(path, { job: { employeeNumber: "A-1" } });
      expect(self.status).toBe(403);
      expect(code(self)).toBe("SECTION_NOT_WRITABLE");

      const groupAdmin = await (await as(users.gabi.id)).patch(path, { job: { legalName: "X" } });
      expect(groupAdmin.status).toBe(403);

      const profile = await (await as(users.owner.id)).get(path);
      expect(profile.body.sections.card.jobTitle).toBeNull();
      expect(profile.body.sections.job.employeeNumber).toBeNull();
    });

    it("follows the stored cell: a Group admin given Job write may write it", async () => {
      const { organizationId, users, employment } = await setUp();
      await setCell(organizationId, "JOB", "GROUP_ADMIN", "WRITE");
      const gabi = await as(users.gabi.id);

      const res = await gabi.patch(`/api/directory/${organizationId}/people/${employment.jana}`, {
        job: { legalName: "Jana Marie Member" },
      });

      expect(res.status).toBe(200);
      expect(res.body.sections.job.legalName).toBe("Jana Marie Member");
    });
  });

  describe("names", () => {
    it("locks a bound person's name and sign-in email to the account", async () => {
      const { organizationId, users, employment } = await setUp();
      const owner = await as(users.owner.id);
      const path = `/api/directory/${organizationId}/people/${employment.jana}`;

      const rename = await owner.patch(path, { card: { name: "Someone Else" } });
      expect(rename.status).toBe(403);
      expect(code(rename)).toBe("NAME_FROM_ACCOUNT");

      const email = await owner.patch(path, { card: { email: "other@example.test" } });
      expect(email.status).toBe(422);

      const profile = await owner.get(path);
      expect(profile.body.name).toBe("Jana Member");
      expect(profile.body.sections.card.nameFromAccount).toBe(true);
      expect(profile.body.account.signInEmail).toBe(
        `${users.jana.id.toLowerCase()}@report-e2e.test`
      );
    });

    it("lets a Card writer rename a person without an account, a Deleted account and a former spell", async () => {
      const { organizationId, users, employment } = await setUp();
      await db.update(user).set({ deletedAt: new Date() }).where(eq(user.id, users.karel.id));
      const dana = await as(users.dana.id);

      for (const [id, name] of [
        [employment.ada, "Ada Lovelace"],
        [employment.karel, "Karel Novak"],
        [employment.petra, "Petra Svobodova"],
      ] as const) {
        const res = await dana.patch(`/api/directory/${organizationId}/people/${id}`, {
          card: { name: `  ${name} ` },
        });
        expect(res.status).toBe(200);
        expect(res.body.name).toBe(name);
        expect(res.body.sections.card.nameFromAccount).toBe(false);
      }

      const list = await (await as(users.jana.id)).get(`/api/directory/${organizationId}/people`);
      const listed = list.body.people.map((person: { name: string }) => person.name);
      expect(listed).toContain("Ada Lovelace");
      expect(listed).toContain("Karel Novak");
      const [karel] = await getPersonContacts([users.karel.id], { organizationId });
      expect(karel!.name).toBe("Karel Novak");
    });

    it("refuses a colleague's rename of a person without an account", async () => {
      const { organizationId, users, employment } = await setUp();
      const res = await (
        await as(users.jana.id)
      ).patch(`/api/directory/${organizationId}/people/${employment.ada}`, {
        card: { name: "Mallory" },
      });
      expect(res.status).toBe(403);
      expect(code(res)).toBe("SECTION_NOT_WRITABLE");
    });
  });

  describe("the plan", () => {
    it("refuses setting a value on a lapsed organization and lets clearing through", async () => {
      const { organizationId, users, employment } = await setUp();
      const owner = await as(users.owner.id);
      const path = `/api/directory/${organizationId}/people/${employment.jana}`;
      await owner.patch(path, {
        card: { jobTitle: "Support specialist" },
        job: { employeeNumber: "A-7" },
      });
      await lapse(organizationId);

      const set = await owner.patch(path, { card: { jobTitle: "Team lead" } });
      expect(set.status).toBe(402);
      expect(set.body.errors[0].context.reason).toBe("PLAN_LIMIT");
      const mixed = await owner.patch(path, { card: { jobTitle: null }, job: { legalName: "X" } });
      expect(mixed.status).toBe(402);

      const clear = await owner.patch(path, {
        card: { jobTitle: null },
        job: { employeeNumber: null },
      });
      expect(clear.status).toBe(200);
      expect(clear.body.sections.card.jobTitle).toBeNull();
      expect(clear.body.sections.job.employeeNumber).toBeNull();
    });
  });

  describe("Job fields", () => {
    it("keeps the employee number unique among open Employments, ignoring case", async () => {
      const { organizationId, users, employment } = await setUp();
      const owner = await as(users.owner.id);
      const at = (id: string) => `/api/directory/${organizationId}/people/${id}`;
      expect(
        (await owner.patch(at(employment.jana), { job: { employeeNumber: "A-0044" } })).status
      ).toBe(200);

      const clash = await owner.patch(at(employment.gabi), { job: { employeeNumber: "a-0044" } });
      expect(clash.status).toBe(409);
      expect(code(clash)).toBe("EMPLOYEE_NUMBER_TAKEN");

      expect(
        (await owner.patch(at(employment.petra), { job: { employeeNumber: "A-0044" } })).status
      ).toBe(200);
      expect(
        (await owner.patch(at(employment.jana), { job: { employeeNumber: "A-0044" } })).status
      ).toBe(200);
    });

    it("frees an employee number once its Employment has ended", async () => {
      const { organizationId, users, employment } = await setUp();
      const owner = await as(users.owner.id);
      const at = (id: string) => `/api/directory/${organizationId}/people/${id}`;
      await owner.patch(at(employment.jana), { job: { employeeNumber: "B-1" } });
      await db
        .update(employments)
        .set({ endedAt: new Date() })
        .where(eq(employments.id, employment.jana));

      expect(
        (await owner.patch(at(employment.gabi), { job: { employeeNumber: "B-1" } })).status
      ).toBe(200);
    });

    it("refuses the employee-only fields on an External worker, and clears them freely", async () => {
      const { organizationId, users, employment } = await setUp();
      const owner = await as(users.owner.id);
      const path = `/api/directory/${organizationId}/people/${employment.eli}`;

      for (const job of [
        { contractType: "PERMANENT" },
        { workingTime: "PART_TIME" },
        { probationEndDate: "2026-12-31" },
      ]) {
        const res = await owner.patch(path, { job });
        expect(res.status).toBe(422);
        expect(code(res)).toBe("EMPLOYEES_ONLY");
      }
      const shared = await owner.patch(path, {
        job: { legalName: "Eli E. External", contractType: null, startDate: "2026-02-01" },
      });
      expect(shared.status).toBe(200);
      expect(shared.body.sections.job).toMatchObject({
        legalName: "Eli E. External",
        startDate: "2026-02-01",
        contractType: null,
      });

      const employee = await owner.patch(
        `/api/directory/${organizationId}/people/${employment.jana}`,
        {
          job: {
            contractType: "FIXED_TERM",
            workingTime: "FULL_TIME",
            probationEndDate: "2026-12-31",
          },
        }
      );
      expect(employee.status).toBe(200);
      expect(employee.body.sections.job).toMatchObject({
        contractType: "FIXED_TERM",
        workingTime: "FULL_TIME",
        probationEndDate: "2026-12-31",
      });
    });

    it("refuses a probation end before the start date, whichever field moves", async () => {
      const { organizationId, users, employment } = await setUp();
      const owner = await as(users.owner.id);
      const path = `/api/directory/${organizationId}/people/${employment.jana}`;

      const both = await owner.patch(path, {
        job: { startDate: "2026-03-01", probationEndDate: "2026-02-28" },
      });
      expect(both.status).toBe(422);
      expect(code(both)).toBe("PROBATION_BEFORE_START");

      await owner.patch(path, { job: { startDate: "2026-03-01", probationEndDate: "2026-06-01" } });
      const later = await owner.patch(path, { job: { startDate: "2026-07-01" } });
      expect(later.status).toBe(422);
      expect(code(later)).toBe("PROBATION_BEFORE_START");
    });

    it("never fills the start date in from the spell, and sends the spell start as the hint", async () => {
      const { organizationId, users, employment } = await setUp();
      const res = await (
        await as(users.owner.id)
      ).get(`/api/directory/${organizationId}/people/${employment.jana}`);
      expect(res.body.sections.job.startDate).toBeNull();
      expect(res.body.sections.job.spell.startedAt).toEqual(expect.any(String));
    });
  });

  describe("Reports to", () => {
    it("names another open Employment of the organization, never the person's own", async () => {
      const { organizationId, users, employment } = await setUp();
      const owner = await as(users.owner.id);
      const path = `/api/directory/${organizationId}/people/${employment.jana}`;

      const set = await owner.patch(path, { card: { reportsToEmploymentId: employment.ada } });
      expect(set.status).toBe(200);
      expect(set.body.sections.card.reportsTo).toEqual({
        employmentId: employment.ada,
        name: "Ada Noaccount",
      });

      const self = await owner.patch(path, { card: { reportsToEmploymentId: employment.jana } });
      expect(self.status).toBe(422);
      expect(code(self)).toBe("REPORTS_TO_SELF");
      const ended = await owner.patch(path, { card: { reportsToEmploymentId: employment.petra } });
      expect(ended.status).toBe(422);
      expect(code(ended)).toBe("REPORTS_TO_NOT_FOUND");
      const elsewhere = await owner.patch(path, { card: { reportsToEmploymentId: uuidv4() } });
      expect(elsewhere.status).toBe(422);
      expect(code(elsewhere)).toBe("REPORTS_TO_NOT_FOUND");
    });
  });

  describe("profile history", () => {
    it("records who changed which fields of which Section, and through which audience, never the values", async () => {
      const { organizationId, users, employment } = await setUp();
      const path = `/api/directory/${organizationId}/people/${employment.jana}`;
      await (
        await as(users.dana.id)
      ).patch(path, {
        card: { jobTitle: "Secret title" },
        job: { employeeNumber: "S-99", legalName: "Jana Secret Member" },
      });
      await (
        await as(users.owner.id)
      ).patch(path, {
        card: { jobTitle: "Secret title", reportsToEmploymentId: employment.owner },
      });

      const res = await (await as(users.owner.id)).get(`${path}/history`);

      expect(res.status).toBe(200);
      expect(
        res.body.map((entry: Record<string, unknown>) => [
          entry.actorName,
          entry.section,
          entry.fields,
          entry.audience,
        ])
      ).toEqual([
        ["Olga Owner", "CARD", ["reportsTo"], "OWNER"],
        ["Dana Delegate", "CARD", ["jobTitle"], "ORGANIZATION_ADMIN"],
        ["Dana Delegate", "JOB", ["legalName", "employeeNumber"], "ORGANIZATION_ADMIN"],
      ]);
      expect(JSON.stringify(res.body)).not.toMatch(/Secret|S-99/);
      const stored = await db
        .select()
        .from(directoryProfileHistory)
        .where(eq(directoryProfileHistory.employmentId, employment.jana));
      expect(JSON.stringify(stored)).not.toMatch(/Secret|S-99/);
    });

    it("records a rename under the Card", async () => {
      const { organizationId, users, employment } = await setUp();
      const path = `/api/directory/${organizationId}/people/${employment.ada}`;
      await (await as(users.dana.id)).patch(path, { card: { name: "Ada Lovelace" } });

      const res = await (await as(users.dana.id)).get(`${path}/history`);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ section: "CARD", fields: ["name"] });
    });

    it("opens the history to the owner and org admins, not to colleagues, the person or a group admin", async () => {
      const { organizationId, users, employment } = await setUp();
      const path = `/api/directory/${organizationId}/people/${employment.jana}/history`;

      for (const viewer of [users.owner, users.dana]) {
        expect((await (await as(viewer.id)).get(path)).status).toBe(200);
      }
      for (const viewer of [users.jana, users.gabi, users.eli]) {
        const res = await (await as(viewer.id)).get(path);
        expect(res.status).toBe(403);
        expect(code(res)).toBe("HISTORY_DENIED");
      }
      const profile = await (
        await as(users.jana.id)
      ).get(`/api/directory/${organizationId}/people/${employment.jana}`);
      expect(profile.body.canReadHistory).toBe(false);
    });

    it("writes no entry when nothing changed", async () => {
      const { organizationId, users, employment } = await setUp();
      const owner = await as(users.owner.id);
      const path = `/api/directory/${organizationId}/people/${employment.jana}`;
      await owner.patch(path, { card: { jobTitle: "Support" } });
      await owner.patch(path, { card: { jobTitle: "Support" }, job: { legalName: null } });

      expect((await owner.get(`${path}/history`)).body).toHaveLength(1);
    });
  });

  describe("exports", () => {
    it("puts a person without an account's Card, Job and history in the Organization export", async () => {
      const { organizationId, users, employment } = await setUp();
      await (
        await as(users.owner.id)
      ).patch(`/api/directory/${organizationId}/people/${employment.ada}`, {
        card: { jobTitle: "Contractor liaison" },
        job: { employeeNumber: "N-1" },
      });

      const { document } = await collectOrganizationExport(organizationId);

      const ada = document.peopleWithoutAccount.find(
        (person) => person.employmentId === employment.ada
      );
      expect(ada?.profile).toMatchObject({ jobTitle: "Contractor liaison", employeeNumber: "N-1" });
      expect(ada?.profileHistory.map((entry) => [entry.section, entry.by])).toEqual([
        ["CARD", "Olga Owner"],
        ["JOB", "Olga Owner"],
      ]);
    });
  });
});

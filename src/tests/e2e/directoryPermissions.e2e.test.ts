import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { directoryPermissionCells } from "../../db/schema/directory-schema.js";
import { directoryPermissionHistory } from "../../db/schema/directory-role-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { enableDirectory } from "../../services/directory/directorySettingsServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { addMember, makeGroup, makeUser } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

type Cell = { row: string; audience: string; value: string; fixed: boolean; options: string[] };

describe("The Permission table editor, Directory roles and Permission history", () => {
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
   * Olga owns the organization. In Support: Hana and Leo (plain members, the
   * role candidates), Dana (org-admin grant), Karel (Deleted account, still
   * open) and Petra (left). Ada has no account.
   */
  const setUp = async () => {
    const owner = await makeUser("Olga Owner");
    const hana = await makeUser("Hana Human");
    const leo = await makeUser("Leo Lead");
    const dana = await makeUser("Dana Delegate");
    const karel = await makeUser("Karel Deleted");
    const petra = await makeUser("Petra Leaver");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    const support = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    await addMember(support, owner.id);
    await syncEmployment(organizationId, owner.id);
    for (const person of [hana, leo, dana, karel, petra]) {
      await addMember(support, person.id);
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

    return {
      organizationId,
      support,
      users: { owner, hana, leo, dana, karel, petra },
      employment: {
        owner: await employmentOf(owner.id),
        hana: await employmentOf(hana.id),
        leo: await employmentOf(leo.id),
        dana: await employmentOf(dana.id),
        karel: await employmentOf(karel.id),
        petra: await employmentOf(petra.id),
        ada,
      },
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
    };
  };

  const lapse = (organizationId: string) =>
    upsertSubscription(organizationId, {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });

  const code = (res: request.Response) => res.body.errors?.[0]?.context?.code;

  const cellOf = (body: { cells: Cell[] }, row: string, audience: string) =>
    body.cells.find((cell) => cell.row === row && cell.audience === audience);

  const storedValue = async (organizationId: string, row: string, audience: string) => {
    const [cell] = await db
      .select({ value: directoryPermissionCells.value })
      .from(directoryPermissionCells)
      .where(
        and(
          eq(directoryPermissionCells.organizationId, organizationId),
          eq(directoryPermissionCells.row, row as never),
          eq(directoryPermissionCells.audience, audience as never)
        )
      );
    return cell?.value;
  };

  describe("reading the table", () => {
    it("shows the owner every cell with its value, whether it is fixed and what it offers", async () => {
      const { organizationId, users } = await setUp();

      const res = await (
        await as(users.owner.id)
      ).get(`/api/directory/${organizationId}/permissions`);

      expect(res.status).toBe(200);
      expect(res.body.editable).toBe(true);
      expect(res.body.writable).toBe(true);
      expect(res.body.cells).toHaveLength(72);
      expect(cellOf(res.body, "CARD", "OWNER")).toEqual({
        row: "CARD",
        audience: "OWNER",
        value: "WRITE",
        fixed: true,
        options: ["WRITE"],
      });
      expect(cellOf(res.body, "JOB", "COLLEAGUE")).toMatchObject({
        value: "NONE",
        fixed: false,
        options: ["NONE", "READ"],
      });
      expect(cellOf(res.body, "END_EMPLOYMENT", "GROUP_ADMIN")).toBeUndefined();
    });

    it("shows an org admin the table read-only, and refuses a member", async () => {
      const { organizationId, users } = await setUp();
      const path = `/api/directory/${organizationId}/permissions`;

      const admin = await (await as(users.dana.id)).get(path);
      expect(admin.status).toBe(200);
      expect(admin.body.editable).toBe(false);

      const member = await (await as(users.hana.id)).get(path);
      expect(member.status).toBe(403);
      expect(code(member)).toBe("PERMISSIONS_DENIED");
    });
    it("tells the list who may open Directory settings", async () => {
      const { organizationId, users, employment } = await setUp();
      await (
        await as(users.owner.id)
      ).put(`/api/directory/${organizationId}/roles/${employment.hana}`, { roles: ["HR"] });
      const path = `/api/directory/${organizationId}/people`;

      for (const [userId, expected] of [
        [users.owner.id, true],
        [users.dana.id, true],
        [users.hana.id, true],
        [users.leo.id, false],
      ] as const) {
        expect((await (await as(userId)).get(path)).body.settings).toBe(expected);
      }
    });
  });

  describe("changing a cell", () => {
    it("lets the owner change a cell, and the change applies at once", async () => {
      const { organizationId, users, employment } = await setUp();
      const owner = await as(users.owner.id);
      const hana = await as(users.hana.id);
      const profile = `/api/directory/${organizationId}/people/${employment.leo}`;
      expect((await hana.get(profile)).body.sections.workContact).toBeDefined();

      const res = await owner.patch(`/api/directory/${organizationId}/permissions`, {
        row: "WORK_CONTACT",
        audience: "COLLEAGUE",
        value: "NONE",
      });

      expect(res.status).toBe(200);
      expect(cellOf(res.body, "WORK_CONTACT", "COLLEAGUE")?.value).toBe("NONE");
      expect(await storedValue(organizationId, "WORK_CONTACT", "COLLEAGUE")).toBe("NONE");
      expect((await hana.get(profile)).body.sections.workContact).toBeUndefined();
    });

    it("refuses every fixed cell, even set to its own value", async () => {
      const { organizationId, users } = await setUp();
      const owner = await as(users.owner.id);
      const path = `/api/directory/${organizationId}/permissions`;

      for (const [row, audience, value] of [
        ["CARD", "OWNER", "READ"],
        ["PERSONAL", "OWNER", "WRITE"],
        ["END_EMPLOYMENT", "OWNER", "NO"],
        ["CARD", "SELF", "WRITE"],
        ["JOB", "SELF", "READ"],
      ]) {
        const res = await owner.patch(path, { row, audience, value });
        expect(res.status, `${row}/${audience}`).toBe(422);
        expect(code(res)).toBe("CELL_FIXED");
      }
      expect(await storedValue(organizationId, "CARD", "SELF")).toBe("READ");
    });

    it("refuses write for Colleague and External worker, and none for Self", async () => {
      const { organizationId, users } = await setUp();
      const owner = await as(users.owner.id);
      const path = `/api/directory/${organizationId}/permissions`;

      for (const [row, audience, value] of [
        ["CARD", "COLLEAGUE", "WRITE"],
        ["PHOTO", "EXTERNAL_WORKER", "WRITE"],
        ["CONTACT", "SELF", "NONE"],
        ["CARD", "HR", "ALLOWED"],
        ["CHANGE_WORKER_TYPE", "HR", "WRITE"],
      ]) {
        const res = await owner.patch(path, { row, audience, value });
        expect(res.status, `${row}/${audience}`).toBe(422);
        expect(code(res)).toBe("VALUE_NOT_OFFERED");
      }
      expect(await storedValue(organizationId, "CARD", "COLLEAGUE")).toBe("READ");
    });

    it("refuses a cell the table doesn't have", async () => {
      const { organizationId, users } = await setUp();
      const res = await (
        await as(users.owner.id)
      ).patch(`/api/directory/${organizationId}/permissions`, {
        row: "END_EMPLOYMENT",
        audience: "GROUP_ADMIN",
        value: "ALLOWED",
      });
      expect(res.status).toBe(422);
      expect(code(res)).toBe("NO_SUCH_CELL");
      expect(await storedValue(organizationId, "END_EMPLOYMENT", "GROUP_ADMIN")).toBeUndefined();
    });

    it("refuses an org admin's change", async () => {
      const { organizationId, users } = await setUp();
      const res = await (
        await as(users.dana.id)
      ).patch(`/api/directory/${organizationId}/permissions`, {
        row: "JOB",
        audience: "LEADERSHIP",
        value: "NONE",
      });
      expect(res.status).toBe(403);
      expect(code(res)).toBe("OWNER_ONLY");
      expect(await storedValue(organizationId, "JOB", "LEADERSHIP")).toBe("READ");
    });
  });

  describe("a lapsed organization", () => {
    it("lets the owner narrow a cell and refuses widening one", async () => {
      const { organizationId, users } = await setUp();
      await lapse(organizationId);
      const owner = await as(users.owner.id);
      const path = `/api/directory/${organizationId}/permissions`;

      expect((await owner.get(path)).body.writable).toBe(false);

      const narrow = await owner.patch(path, { row: "JOB", audience: "LEADERSHIP", value: "NONE" });
      expect(narrow.status).toBe(200);
      const narrowAct = await owner.patch(path, {
        row: "END_EMPLOYMENT",
        audience: "HR",
        value: "NO",
      });
      expect(narrowAct.status).toBe(200);

      const widen = await owner.patch(path, { row: "JOB", audience: "LEADERSHIP", value: "READ" });
      expect(widen.status).toBe(402);
      expect(widen.body.errors?.[0]?.context?.reason).toBe("PLAN_LIMIT");
      const widenAct = await owner.patch(path, {
        row: "END_EMPLOYMENT",
        audience: "HR",
        value: "ALLOWED",
      });
      expect(widenAct.status).toBe(402);

      expect(await storedValue(organizationId, "JOB", "LEADERSHIP")).toBe("NONE");
      expect(await storedValue(organizationId, "END_EMPLOYMENT", "HR")).toBe("NO");
    });
  });

  describe("a cell the stored copy lacks", () => {
    it("reads as the product default and can be changed", async () => {
      const { organizationId, users, employment } = await setUp();
      await db
        .delete(directoryPermissionCells)
        .where(
          and(
            eq(directoryPermissionCells.organizationId, organizationId),
            eq(directoryPermissionCells.row, "WORK_CONTACT" as never)
          )
        );
      const owner = await as(users.owner.id);
      const path = `/api/directory/${organizationId}/permissions`;

      expect(cellOf((await owner.get(path)).body, "WORK_CONTACT", "COLLEAGUE")?.value).toBe("READ");
      const hana = await as(users.hana.id);
      const profile = `/api/directory/${organizationId}/people/${employment.leo}`;
      expect((await hana.get(profile)).body.sections.workContact).toBeDefined();

      const res = await owner.patch(path, {
        row: "WORK_CONTACT",
        audience: "COLLEAGUE",
        value: "NONE",
      });
      expect(res.status).toBe(200);
      expect(await storedValue(organizationId, "WORK_CONTACT", "COLLEAGUE")).toBe("NONE");
      const [entry] = await db
        .select()
        .from(directoryPermissionHistory)
        .where(eq(directoryPermissionHistory.organizationId, organizationId));
      expect(entry).toMatchObject({ valueBefore: "READ", valueAfter: "NONE" });
    });
  });

  describe("Directory roles", () => {
    const rolesPath = (organizationId: string, employmentId?: string) =>
      `/api/directory/${organizationId}/roles${employmentId ? `/${employmentId}` : ""}`;

    it("lets the owner give one person both roles, and they then read as HR and Leadership", async () => {
      const { organizationId, users, employment } = await setUp();
      const owner = await as(users.owner.id);
      const hana = await as(users.hana.id);
      const former = `/api/directory/${organizationId}/former`;
      expect((await hana.get(former)).status).toBe(403);

      const res = await owner.put(rolesPath(organizationId, employment.hana), {
        roles: ["LEADERSHIP", "HR"],
      });

      expect(res.status).toBe(200);
      const holder = res.body.people.find(
        (person: { employmentId: string }) => person.employmentId === employment.hana
      );
      expect(holder.roles).toEqual(["HR", "LEADERSHIP"]);
      expect((await hana.get(former)).status).toBe(200);
      const leo = await hana.get(`/api/directory/${organizationId}/people/${employment.leo}`);
      expect(leo.body.sections.contact).toEqual(expect.objectContaining({ level: "WRITE" }));
      expect(leo.body.canReadHistory).toBe(true);
      const own = await hana.get(`/api/directory/${organizationId}/people/${employment.hana}`);
      expect(own.body.account.directoryRoles).toEqual(["HR", "LEADERSHIP"]);
      expect((await hana.get(`/api/directory/${organizationId}/permissions`)).status).toBe(200);
    });

    it("lists only open Employments with a live account, and keeps the org admin roleless", async () => {
      const { organizationId, users, employment } = await setUp();
      const res = await (await as(users.owner.id)).get(rolesPath(organizationId));

      expect(res.status).toBe(200);
      expect(res.body.editable).toBe(true);
      const ids = res.body.people.map((person: { employmentId: string }) => person.employmentId);
      expect(ids).toContain(employment.hana);
      expect(ids).not.toContain(employment.ada);
      expect(ids).not.toContain(employment.karel);
      expect(ids).not.toContain(employment.petra);
      const dana = res.body.people.find(
        (person: { employmentId: string }) => person.employmentId === employment.dana
      );
      expect(dana.roles).toEqual([]);
    });

    it("refuses a role on an account-less, an ended or a Deleted account's Employment", async () => {
      const { organizationId, users, employment } = await setUp();
      const owner = await as(users.owner.id);

      for (const [employmentId, expected] of [
        [employment.ada, "NO_ACCOUNT"],
        [employment.petra, "EMPLOYMENT_ENDED"],
        [employment.karel, "ACCOUNT_DELETED"],
      ] as const) {
        const res = await owner.put(rolesPath(organizationId, employmentId), { roles: ["HR"] });
        expect(res.status, expected).toBe(422);
        expect(code(res)).toBe(expected);
      }
      const history = await owner.get(`/api/directory/${organizationId}/permissions/history`);
      expect(history.body).toEqual([]);
    });

    it("refuses an org admin and HR, who read the roles but can't change them", async () => {
      const { organizationId, users, employment } = await setUp();
      const owner = await as(users.owner.id);
      await owner.put(rolesPath(organizationId, employment.hana), { roles: ["HR"] });

      for (const userId of [users.dana.id, users.hana.id]) {
        const viewer = await as(userId);
        const read = await viewer.get(rolesPath(organizationId));
        expect(read.status).toBe(200);
        expect(read.body.editable).toBe(false);
        const table = await viewer.get(`/api/directory/${organizationId}/permissions`);
        expect(table.body.editable).toBe(false);

        const assign = await viewer.put(rolesPath(organizationId, employment.leo), {
          roles: ["LEADERSHIP"],
        });
        expect(assign.status).toBe(403);
        expect(code(assign)).toBe("OWNER_ONLY");
        const cell = await viewer.patch(`/api/directory/${organizationId}/permissions`, {
          row: "JOB",
          audience: "LEADERSHIP",
          value: "NONE",
        });
        expect(cell.status).toBe(403);
        expect(code(cell)).toBe("OWNER_ONLY");
      }
      const roles = await owner.get(rolesPath(organizationId));
      const leo = roles.body.people.find(
        (person: { employmentId: string }) => person.employmentId === employment.leo
      );
      expect(leo.roles).toEqual([]);
      expect(await storedValue(organizationId, "JOB", "LEADERSHIP")).toBe("READ");
    });

    it("refuses a member the roles list", async () => {
      const { organizationId, users } = await setUp();
      const res = await (await as(users.leo.id)).get(rolesPath(organizationId));
      expect(res.status).toBe(403);
      expect(code(res)).toBe("PERMISSIONS_DENIED");
    });

    it("ends the roles with the Employment, and a rejoin starts without them", async () => {
      const { organizationId, support, users, employment } = await setUp();
      const owner = await as(users.owner.id);
      await owner.put(rolesPath(organizationId, employment.hana), { roles: ["HR", "LEADERSHIP"] });

      // In a Directory organization only End employment ends a spell.
      const today = new Date().toISOString().slice(0, 10);
      const ending = await request(server.url)
        .post(`/api/employment/${employment.hana}/end`)
        .set("Cookie", await authCookieFor(users.owner.id))
        .send({ endedOn: today });
      expect(ending.status).toBe(200);

      const history = await owner.get(`/api/directory/${organizationId}/permissions/history`);
      const ended = history.body.filter(
        (entry: { reason?: string }) => entry.reason === "EMPLOYMENT_ENDED"
      );
      expect(ended).toHaveLength(2);
      expect(ended[0]).toMatchObject({
        kind: "ROLE",
        employmentId: employment.hana,
        personName: "Hana Human",
        before: true,
        after: false,
        actorName: "Olga Owner",
      });

      await addMember(support, users.hana.id);
      await syncEmployment(organizationId, users.hana.id);
      const hana = await as(users.hana.id);
      expect((await hana.get(`/api/directory/${organizationId}/former`)).status).toBe(403);
      const roles = await owner.get(rolesPath(organizationId));
      const rejoined = roles.body.people.find(
        (person: { name: string }) => person.name === "Hana Human"
      );
      expect(rejoined.employmentId).not.toBe(employment.hana);
      expect(rejoined.roles).toEqual([]);
    });

    it("lets a lapsed organization's owner remove a role but not add one", async () => {
      const { organizationId, users, employment } = await setUp();
      const owner = await as(users.owner.id);
      await owner.put(rolesPath(organizationId, employment.hana), { roles: ["HR"] });
      await lapse(organizationId);

      const add = await owner.put(rolesPath(organizationId, employment.leo), {
        roles: ["LEADERSHIP"],
      });
      expect(add.status).toBe(402);
      const remove = await owner.put(rolesPath(organizationId, employment.hana), { roles: [] });
      expect(remove.status).toBe(200);
      expect(remove.body.writable).toBe(false);
    });
  });

  describe("Permission history", () => {
    it("records each cell change and each role change with before and after", async () => {
      const { organizationId, users, employment } = await setUp();
      const owner = await as(users.owner.id);
      const path = `/api/directory/${organizationId}/permissions`;

      await owner.patch(path, { row: "JOB", audience: "GROUP_ADMIN", value: "NONE" });
      await owner.patch(path, { row: "JOB", audience: "GROUP_ADMIN", value: "NONE" });
      await owner.patch(path, { row: "END_EMPLOYMENT", audience: "LEADERSHIP", value: "ALLOWED" });
      await owner.put(`/api/directory/${organizationId}/roles/${employment.leo}`, {
        roles: ["LEADERSHIP"],
      });
      await owner.put(`/api/directory/${organizationId}/roles/${employment.leo}`, { roles: [] });

      const res = await owner.get(`${path}/history`);

      expect(res.status).toBe(200);
      const entries = res.body.map(
        ({ id: _id, at: _at, ...rest }: Record<string, unknown>) => rest
      );
      expect(entries).toEqual([
        {
          kind: "ROLE",
          actorName: "Olga Owner",
          role: "LEADERSHIP",
          employmentId: employment.leo,
          personName: "Leo Lead",
          before: true,
          after: false,
          reason: "OWNER",
        },
        {
          kind: "ROLE",
          actorName: "Olga Owner",
          role: "LEADERSHIP",
          employmentId: employment.leo,
          personName: "Leo Lead",
          before: false,
          after: true,
          reason: "OWNER",
        },
        {
          kind: "CELL",
          actorName: "Olga Owner",
          row: "END_EMPLOYMENT",
          audience: "LEADERSHIP",
          before: "NO",
          after: "ALLOWED",
        },
        {
          kind: "CELL",
          actorName: "Olga Owner",
          row: "JOB",
          audience: "GROUP_ADMIN",
          before: "READ",
          after: "NONE",
        },
      ]);
    });

    it("opens the history to org admins and HR, not to a member", async () => {
      const { organizationId, users, employment } = await setUp();
      const owner = await as(users.owner.id);
      await owner.put(`/api/directory/${organizationId}/roles/${employment.hana}`, {
        roles: ["HR"],
      });
      const path = `/api/directory/${organizationId}/permissions/history`;

      expect((await (await as(users.dana.id)).get(path)).status).toBe(200);
      expect((await (await as(users.hana.id)).get(path)).body).toHaveLength(1);
      const member = await (await as(users.leo.id)).get(path);
      expect(member.status).toBe(403);
      expect(code(member)).toBe("PERMISSIONS_DENIED");
    });

    it("keeps an erased person's role entries without the person", async () => {
      const { organizationId, users, employment } = await setUp();
      const owner = await as(users.owner.id);
      await owner.put(`/api/directory/${organizationId}/roles/${employment.leo}`, {
        roles: ["LEADERSHIP"],
      });

      await db.delete(employments).where(eq(employments.id, employment.leo));

      const res = await owner.get(`/api/directory/${organizationId}/permissions/history`);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ kind: "ROLE", employmentId: null, personName: null });
    });
  });
});

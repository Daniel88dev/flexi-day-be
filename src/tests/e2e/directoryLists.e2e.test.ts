import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { directoryProfileHistory } from "../../db/schema/directory-profile-schema.js";
import { directoryRoleAssignments } from "../../db/schema/directory-role-schema.js";
import { directoryPermissionCells } from "../../db/schema/directory-schema.js";
import { employments, workerType } from "../../db/schema/employment-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import {
  subscriptionPlan,
  subscriptionStatus,
  subscriptions,
} from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { enableDirectory } from "../../services/directory/directorySettingsServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { addMember, makeGroup, makeUser } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

describe("Departments and Locations", () => {
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
   * member), Gabi (admin access, a Group admin), Dana (org-admin grant), Hana
   * (HR), Lea (Leadership), Eli (External worker) and Petra (left).
   */
  const setUp = async () => {
    const owner = await makeUser("Olga Owner");
    const jana = await makeUser("Jana Member");
    const gabi = await makeUser("Gabi Groupadmin");
    const dana = await makeUser("Dana Delegate");
    const hana = await makeUser("Hana Hr");
    const lea = await makeUser("Lea Leadership");
    const eli = await makeUser("Eli External");
    const petra = await makeUser("Petra Leaver");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    const support = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    await addMember(support, owner.id);
    await syncEmployment(organizationId, owner.id);
    for (const person of [jana, gabi, dana, hana, lea, eli, petra]) {
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
    const employment = {
      owner: await employmentOf(owner.id),
      jana: await employmentOf(jana.id),
      hana: await employmentOf(hana.id),
      lea: await employmentOf(lea.id),
      petra: await employmentOf(petra.id),
    };
    await db.insert(directoryRoleAssignments).values([
      { employmentId: employment.hana, role: "HR", organizationId },
      { employmentId: employment.lea, role: "LEADERSHIP", organizationId },
    ]);
    await db
      .update(employments)
      .set({ endedAt: new Date("2026-03-31T12:00:00Z") })
      .where(eq(employments.id, employment.petra));

    return {
      organizationId,
      users: { owner, jana, gabi, dana, hana, lea, eli, petra },
      employment,
    };
  };

  const as = async (userId: string) => {
    const cookie = await authCookieFor(userId);
    return {
      get: (path: string) => request(server.url).get(path).set("Cookie", cookie),
      post: (path: string, body: object) =>
        request(server.url).post(path).set("Cookie", cookie).send(body),
      put: (path: string, body: object) =>
        request(server.url).put(path).set("Cookie", cookie).send(body),
      patch: (path: string, body: object) =>
        request(server.url).patch(path).set("Cookie", cookie).send(body),
      delete: (path: string) => request(server.url).delete(path).set("Cookie", cookie),
    };
  };

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

  const code = (res: request.Response) => res.body.errors?.[0]?.context?.code;
  const entryNamed = (res: request.Response, name: string) =>
    res.body.entries.find((entry: { name: string }) => entry.name === name);

  const addEntries = async (organizationId: string, ownerId: string) => {
    const owner = await as(ownerId);
    const base = `/api/directory/${organizationId}`;
    return {
      support: (await owner.post(`${base}/departments`, { name: "Support" })).body.id as string,
      sales: (await owner.post(`${base}/departments`, { name: "Sales" })).body.id as string,
      berlin: (await owner.post(`${base}/locations`, { name: "Berlin", country: "DE" })).body
        .id as string,
      remote: (await owner.post(`${base}/locations`, { name: "Remote" })).body.id as string,
    };
  };

  const rowOf = (res: request.Response, employmentId: string) =>
    res.body.people.find(
      (person: { employmentId: string }) => person.employmentId === employmentId
    );

  describe("on the Card", () => {
    it("sets a Department and a Location, which every Card reader sees on the list and the profile", async () => {
      const { organizationId, users, employment } = await setUp();
      const entries = await addEntries(organizationId, users.owner.id);
      const path = `/api/directory/${organizationId}/people/${employment.jana}`;

      const res = await (
        await as(users.hana.id)
      ).patch(path, {
        card: { departmentId: entries.support, locationId: entries.berlin },
      });
      expect(res.status).toBe(200);
      expect(res.body.sections.card.department).toEqual({
        id: entries.support,
        name: "Support",
        archived: false,
      });

      const eli = await as(users.eli.id);
      const profile = await eli.get(`${path}?language=en`);
      expect(profile.body.sections.card.location).toEqual({
        id: entries.berlin,
        name: "Berlin",
        archived: false,
        country: { code: "DE", name: "Germany" },
      });
      const row = rowOf(await eli.get(`/api/directory/${organizationId}/people`), employment.jana);
      expect(row.department).toEqual({ id: entries.support, name: "Support", archived: false });
      expect(row.location).toEqual({ id: entries.berlin, name: "Berlin", archived: false });
      const unset = rowOf(
        await eli.get(`/api/directory/${organizationId}/people`),
        employment.owner
      );
      expect(unset.department).toBeNull();
      expect(unset.location).toBeNull();
    });

    it("records the change in the profile history under the Card", async () => {
      const { organizationId, users, employment } = await setUp();
      const entries = await addEntries(organizationId, users.owner.id);
      const owner = await as(users.owner.id);
      const path = `/api/directory/${organizationId}/people/${employment.jana}`;

      await owner.patch(path, { card: { departmentId: entries.support } });
      await owner.patch(path, {
        card: { departmentId: entries.support, locationId: entries.remote },
      });
      await owner.patch(path, { card: { departmentId: null } });

      const rows = await db
        .select({
          fields: directoryProfileHistory.fields,
          section: directoryProfileHistory.section,
        })
        .from(directoryProfileHistory)
        .where(eq(directoryProfileHistory.employmentId, employment.jana))
        .orderBy(directoryProfileHistory.createdAt);
      expect(rows).toEqual([
        { section: "CARD", fields: ["department"] },
        { section: "CARD", fields: ["location"] },
        { section: "CARD", fields: ["department"] },
      ]);
    });

    it("refuses an entry from another organization's list or no list at all", async () => {
      const { organizationId, users, employment } = await setUp();
      const owner = await as(users.owner.id);
      const path = `/api/directory/${organizationId}/people/${employment.jana}`;
      const res = await owner.patch(path, { card: { departmentId: "nope" } });
      expect(res.status).toBe(422);
      expect(code(res)).toBe("ENTRY_NOT_FOUND");
      const swapped = await addEntries(organizationId, users.owner.id);
      const location = await owner.patch(path, { card: { locationId: swapped.support } });
      expect(location.status).toBe(422);
      expect(code(location)).toBe("ENTRY_NOT_FOUND");
    });

    it("refuses a viewer who can't write the Card", async () => {
      const { organizationId, users, employment } = await setUp();
      const entries = await addEntries(organizationId, users.owner.id);
      const res = await (
        await as(users.lea.id)
      ).patch(`/api/directory/${organizationId}/people/${employment.jana}`, {
        card: { departmentId: entries.support },
      });
      expect(res.status).toBe(403);
      expect(code(res)).toBe("SECTION_NOT_WRITABLE");
    });

    it("starts the phone country on the Location's country, then the language", async () => {
      const { organizationId, users, employment } = await setUp();
      const entries = await addEntries(organizationId, users.owner.id);
      const owner = await as(users.owner.id);
      const path = `/api/directory/${organizationId}/people/${employment.jana}`;

      const none = await owner.get(`${path}?language=cs`);
      expect(none.body.sections.workContact.phoneCountryDefault).toEqual({
        code: "CZ",
        name: "Česko",
      });
      await owner.patch(path, { card: { locationId: entries.berlin } });
      const berlin = await owner.get(`${path}?language=cs`);
      expect(berlin.body.sections.workContact.phoneCountryDefault).toEqual({
        code: "DE",
        name: "Německo",
      });
      expect(berlin.body.sections.contact.phoneCountryDefault).toEqual({
        code: "DE",
        name: "Německo",
      });
      await owner.patch(path, { card: { locationId: entries.remote } });
      const remote = await owner.get(`${path}?language=en`);
      expect(remote.body.sections.workContact.phoneCountryDefault).toBeNull();
    });
  });

  describe("entries in use", () => {
    it("deletes an unused entry, and refuses one a record holds, open or former, which can be archived instead", async () => {
      const { organizationId, users, employment } = await setUp();
      const entries = await addEntries(organizationId, users.owner.id);
      const owner = await as(users.owner.id);
      const base = `/api/directory/${organizationId}`;
      await owner.patch(`${base}/people/${employment.petra}`, {
        card: { departmentId: entries.support, locationId: entries.berlin },
      });

      expect((await owner.delete(`${base}/departments/${entries.sales}`)).status).toBe(204);
      expect((await owner.delete(`${base}/locations/${entries.remote}`)).status).toBe(204);
      const inUse = await owner.delete(`${base}/departments/${entries.support}`);
      expect(inUse.status).toBe(409);
      expect(code(inUse)).toBe("ENTRY_IN_USE");
      expect((await owner.delete(`${base}/locations/${entries.berlin}`)).status).toBe(409);

      const list = await owner.get(`${base}/departments`);
      expect(list.body.entries).toEqual([
        { id: entries.support, name: "Support", archived: false, inUse: true },
      ]);
      const archived = await owner.patch(`${base}/departments/${entries.support}`, {
        archived: true,
      });
      expect(archived.status).toBe(200);
      expect(archived.body).toEqual({
        id: entries.support,
        name: "Support",
        archived: true,
        inUse: true,
      });
      const former = await owner.get(`${base}/people/${employment.petra}`);
      expect(former.body.sections.card.department).toEqual({
        id: entries.support,
        name: "Support",
        archived: true,
      });
    });

    it("keeps an archived entry from anyone new while the record holding it keeps it", async () => {
      const { organizationId, users, employment } = await setUp();
      const entries = await addEntries(organizationId, users.owner.id);
      const owner = await as(users.owner.id);
      const base = `/api/directory/${organizationId}`;
      await owner.patch(`${base}/people/${employment.jana}`, {
        card: { departmentId: entries.support },
      });
      await owner.patch(`${base}/departments/${entries.support}`, { archived: true });

      const someoneNew = await owner.patch(`${base}/people/${employment.hana}`, {
        card: { departmentId: entries.support },
      });
      expect(someoneNew.status).toBe(422);
      expect(code(someoneNew)).toBe("ENTRY_ARCHIVED");
      const keeps = await owner.patch(`${base}/people/${employment.jana}`, {
        card: { departmentId: entries.support, jobTitle: "Agent" },
      });
      expect(keeps.status).toBe(200);
      expect(keeps.body.sections.card.department.archived).toBe(true);
      const list = await owner.get(`${base}/people`);
      expect(rowOf(list, employment.jana).department).toEqual({
        id: entries.support,
        name: "Support",
        archived: true,
      });

      const restored = await owner.patch(`${base}/departments/${entries.support}`, {
        archived: false,
      });
      expect(restored.body.archived).toBe(false);
      expect(
        (
          await owner.patch(`${base}/people/${employment.hana}`, {
            card: { departmentId: entries.support },
          })
        ).status
      ).toBe(200);
    });

    it("lets Erase take the record and frees the entry", async () => {
      const { organizationId, users, employment } = await setUp();
      const entries = await addEntries(organizationId, users.owner.id);
      const owner = await as(users.owner.id);
      const base = `/api/directory/${organizationId}`;
      await owner.patch(`${base}/people/${employment.petra}`, {
        card: { departmentId: entries.support },
      });
      await db.delete(employments).where(eq(employments.id, employment.petra));
      expect((await owner.delete(`${base}/departments/${entries.support}`)).status).toBe(204);
    });

    it("leaves the record with the Card when retention empties it, and frees the entries", async () => {
      const { organizationId, users, employment } = await setUp();
      const entries = await addEntries(organizationId, users.owner.id);
      const owner = await as(users.owner.id);
      const base = `/api/directory/${organizationId}`;
      await owner.patch(`${base}/people/${employment.jana}`, {
        card: { departmentId: entries.support, locationId: entries.berlin },
      });
      expect(
        (await owner.put(`${base}/settings/retention`, { section: "CARD", period: "AT_END" }))
          .status
      ).toBe(200);

      const ended = await owner.post(`/api/employment/${employment.jana}/end`, {
        endedOn: new Date().toISOString().slice(0, 10),
      });
      expect(ended.status).toBe(200);

      const profile = await owner.get(`${base}/people/${employment.jana}`);
      expect(profile.body.sections.card.department).toBeNull();
      expect(profile.body.sections.card.location).toBeNull();
      const [purge] = await db
        .select({ fields: directoryProfileHistory.fields })
        .from(directoryProfileHistory)
        .where(
          and(
            eq(directoryProfileHistory.employmentId, employment.jana),
            eq(directoryProfileHistory.actor, "RETENTION")
          )
        );
      expect(purge?.fields).toEqual(expect.arrayContaining(["department", "location"]));
      expect((await owner.delete(`${base}/departments/${entries.support}`)).status).toBe(204);
    });

    it("goes with the organization", async () => {
      const { organizationId, users, employment } = await setUp();
      const entries = await addEntries(organizationId, users.owner.id);
      await (
        await as(users.owner.id)
      ).patch(`/api/directory/${organizationId}/people/${employment.jana}`, {
        card: { departmentId: entries.support, locationId: entries.berlin },
      });
      // The order account deletion uses for an owned organization.
      await db.transaction(async (tx) => {
        await tx.delete(groups).where(eq(groups.organizationId, organizationId));
        await tx.delete(subscriptions).where(eq(subscriptions.organizationId, organizationId));
        await tx.delete(organizations).where(eq(organizations.id, organizationId));
      });
      const [left] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, organizationId));
      expect(left).toBeUndefined();
    });
  });

  describe("a lapsed organization", () => {
    it("refuses adding an entry with 402, and still renames, archives and deletes", async () => {
      const { organizationId, users, employment } = await setUp();
      const entries = await addEntries(organizationId, users.owner.id);
      await (
        await as(users.owner.id)
      ).patch(`/api/directory/${organizationId}/people/${employment.jana}`, {
        card: { departmentId: entries.support },
      });
      await lapse(organizationId);
      const hana = await as(users.hana.id);
      const base = `/api/directory/${organizationId}`;

      const added = await hana.post(`${base}/departments`, { name: "Legal" });
      expect(added.status).toBe(402);
      expect(added.body.errors[0].context.reason).toBe("PLAN_LIMIT");
      expect((await hana.post(`${base}/locations`, { name: "Brno" })).status).toBe(402);

      const list = await hana.get(`${base}/departments`);
      expect(list.body.writable).toBe(false);
      expect(list.body.editable).toBe(true);

      const renamed = await hana.patch(`${base}/departments/${entries.support}`, {
        name: "Customer support",
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body.name).toBe("Customer support");
      const archived = await hana.patch(`${base}/departments/${entries.support}`, {
        archived: true,
      });
      expect(archived.status).toBe(200);
      expect((await hana.delete(`${base}/departments/${entries.sales}`)).status).toBe(204);
      expect(
        (await hana.patch(`${base}/locations/${entries.berlin}`, { country: null })).status
      ).toBe(200);

      expect(
        (await hana.patch(`${base}/departments/${entries.support}`, { archived: false })).status
      ).toBe(402);
      expect(
        (await hana.patch(`${base}/locations/${entries.berlin}`, { country: "AT" })).status
      ).toBe(402);

      const clear = await hana.patch(`${base}/people/${employment.jana}`, {
        card: { departmentId: null },
      });
      expect(clear.status).toBe(200);
      expect(clear.body.sections.card.department).toBeNull();
      const set = await hana.patch(`${base}/people/${employment.jana}`, {
        card: { locationId: entries.remote },
      });
      expect(set.status).toBe(402);
    });
  });

  describe("managing the lists", () => {
    it("lets the owner, an org admin and HR add entries, and everyone in the directory reads the list", async () => {
      const { organizationId, users } = await setUp();
      const path = `/api/directory/${organizationId}/departments`;

      for (const [userId, name] of [
        [users.owner.id, "Support"],
        [users.dana.id, "  Finance "],
        [users.hana.id, "Engineering"],
      ] as const) {
        const res = await (await as(userId)).post(path, { name });
        expect(res.status).toBe(201);
        expect(res.body).toEqual({
          id: expect.any(String),
          name: name.trim(),
          archived: false,
          inUse: false,
        });
      }

      const manager = await (await as(users.hana.id)).get(path);
      expect(manager.status).toBe(200);
      expect(manager.body.editable).toBe(true);
      expect(manager.body.writable).toBe(true);
      expect(manager.body.entries.map((entry: { name: string }) => entry.name)).toEqual([
        "Engineering",
        "Finance",
        "Support",
      ]);

      const colleague = await (await as(users.jana.id)).get(path);
      expect(colleague.status).toBe(200);
      expect(colleague.body.editable).toBe(false);
      expect(colleague.body.entries[0]).toEqual({
        id: expect.any(String),
        name: "Engineering",
        archived: false,
      });
    });

    it("refuses Group admin, Leadership, colleagues and External workers under the default table", async () => {
      const { organizationId, users } = await setUp();
      const owner = await as(users.owner.id);
      const path = `/api/directory/${organizationId}/locations`;
      const prague = (await owner.post(path, { name: "Prague" })).body;

      for (const userId of [users.gabi.id, users.lea.id, users.jana.id, users.eli.id]) {
        const viewer = await as(userId);
        const added = await viewer.post(path, { name: "Brno" });
        expect(added.status).toBe(403);
        expect(code(added)).toBe("LISTS_DENIED");
        const renamed = await viewer.patch(`${path}/${prague.id}`, { name: "Praha" });
        expect(renamed.status).toBe(403);
        const deleted = await viewer.delete(`${path}/${prague.id}`);
        expect(deleted.status).toBe(403);
      }

      const list = await owner.get(path);
      expect(list.body.entries.map((entry: { name: string }) => entry.name)).toEqual(["Prague"]);
    });

    it("follows the stored cells: Leadership and a Group admin given the row may add", async () => {
      const { organizationId, users } = await setUp();
      await setCell(organizationId, "MANAGE_DEPARTMENTS_AND_LOCATIONS", "LEADERSHIP", "ALLOWED");
      await setCell(organizationId, "MANAGE_DEPARTMENTS_AND_LOCATIONS", "GROUP_ADMIN", "ALLOWED");
      await setCell(organizationId, "MANAGE_DEPARTMENTS_AND_LOCATIONS", "HR", "NO");
      const path = `/api/directory/${organizationId}/departments`;

      expect((await (await as(users.lea.id)).post(path, { name: "Sales" })).status).toBe(201);
      expect((await (await as(users.gabi.id)).post(path, { name: "Legal" })).status).toBe(201);
      const hr = await (await as(users.hana.id)).post(path, { name: "People" });
      expect(hr.status).toBe(403);
      expect(code(hr)).toBe("LISTS_DENIED");
    });

    it("reads the row at its default when an organization's stored copy lacks it", async () => {
      const { organizationId, users } = await setUp();
      await db
        .delete(directoryPermissionCells)
        .where(
          and(
            eq(directoryPermissionCells.organizationId, organizationId),
            eq(directoryPermissionCells.row, "MANAGE_DEPARTMENTS_AND_LOCATIONS")
          )
        );

      const table = await (
        await as(users.owner.id)
      ).get(`/api/directory/${organizationId}/permissions`);
      const cells = table.body.cells
        .filter((cell: { row: string }) => cell.row === "MANAGE_DEPARTMENTS_AND_LOCATIONS")
        .map((cell: { audience: string; value: string; fixed: boolean }) => [
          cell.audience,
          cell.value,
          cell.fixed,
        ]);
      expect(cells).toEqual([
        ["OWNER", "ALLOWED", true],
        ["GROUP_ADMIN", "NO", false],
        ["HR", "ALLOWED", false],
        ["LEADERSHIP", "NO", false],
        ["ORGANIZATION_ADMIN", "ALLOWED", false],
      ]);

      const path = `/api/directory/${organizationId}/departments`;
      expect((await (await as(users.hana.id)).post(path, { name: "Support" })).status).toBe(201);
      expect((await (await as(users.dana.id)).post(path, { name: "Sales" })).status).toBe(201);
      expect((await (await as(users.lea.id)).post(path, { name: "Legal" })).status).toBe(403);
      expect((await (await as(users.gabi.id)).post(path, { name: "Legal" })).status).toBe(403);
    });

    it("keeps names unique within a list, ignoring case, archived entries included", async () => {
      const { organizationId, users } = await setUp();
      const owner = await as(users.owner.id);
      const path = `/api/directory/${organizationId}/departments`;
      const support = (await owner.post(path, { name: "Support" })).body;
      const sales = (await owner.post(path, { name: "Sales" })).body;
      await owner.patch(`${path}/${support.id}`, { archived: true });

      const again = await owner.post(path, { name: "support" });
      expect(again.status).toBe(409);
      expect(code(again)).toBe("NAME_TAKEN");
      const rename = await owner.patch(`${path}/${sales.id}`, { name: "SUPPORT" });
      expect(rename.status).toBe(409);
      expect(code(rename)).toBe("NAME_TAKEN");
      expect((await owner.patch(`${path}/${sales.id}`, { name: "sales" })).status).toBe(200);
      expect(
        (await owner.post(`/api/directory/${organizationId}/locations`, { name: "Support" })).status
      ).toBe(201);
    });

    it("stores a Location's country and names it in the viewer's language", async () => {
      const { organizationId, users } = await setUp();
      const owner = await as(users.owner.id);
      const path = `/api/directory/${organizationId}/locations`;

      const berlin = await owner.post(`${path}?language=cs`, { name: "Berlin", country: "de" });
      expect(berlin.status).toBe(201);
      expect(berlin.body.country).toEqual({ code: "DE", name: "Německo" });
      const remote = await owner.post(path, { name: "Remote" });
      expect(remote.body.country).toBeNull();

      const invalid = await owner.post(path, { name: "Atlantis", country: "XX" });
      expect(invalid.status).toBe(422);
      expect(code(invalid)).toBe("INVALID_COUNTRY");
      const changed = await owner.patch(`${path}/${berlin.body.id}?language=en`, {
        country: "AT",
      });
      expect(changed.body.country).toEqual({ code: "AT", name: "Austria" });
      const cleared = await owner.patch(`${path}/${berlin.body.id}`, { country: null });
      expect(cleared.body.country).toBeNull();
      const departmentCountry = await owner.post(`/api/directory/${organizationId}/departments`, {
        name: "Support",
        country: "CZ",
      });
      expect(departmentCountry.status).toBe(422);
    });

    it("keeps lists apart between organizations", async () => {
      const { organizationId, users } = await setUp();
      const owner = await as(users.owner.id);
      const support = (
        await owner.post(`/api/directory/${organizationId}/departments`, { name: "Support" })
      ).body;
      const other = await makeUser("Otto Other");
      const otherOrganization = (await ensureOrganizationForUser(other.id)).id;
      await upsertSubscription(otherOrganization, {
        plan: subscriptionPlan.Enterprise,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });
      await db.transaction((tx) =>
        enableDirectory(
          { organizationId: otherOrganization, userId: other.id, agreementVersion: 1 },
          tx
        )
      );
      const otto = await as(other.id);

      const rename = await otto.patch(
        `/api/directory/${otherOrganization}/departments/${support.id}`,
        { name: "Mine" }
      );
      expect(rename.status).toBe(404);
      expect(code(rename)).toBe("ENTRY_NOT_FOUND");
      expect(
        (await otto.get(`/api/directory/${otherOrganization}/departments`)).body.entries
      ).toEqual([]);
    });
  });
});

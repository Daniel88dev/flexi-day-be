import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import {
  directoryAgreementAcceptances,
  directoryPermissionCells,
  directoryPermissionRow,
  directoryAudience,
  directoryPermissionValue,
  organizationDirectorySettings,
} from "../../db/schema/directory-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import {
  manualPlanOverride,
  subscriptionPlan,
  subscriptionStatus,
} from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { getOrganizationDetailForSupport } from "../../services/support/supportServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { addMember, makeGroup, makeUser } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { apiAs } from "./helpers/directoryWorld.js";

const agreement = vi.hoisted(() => ({ version: 1 }));
vi.mock("../../services/directory/directoryAgreement.js", () => ({
  get DIRECTORY_AGREEMENT_VERSION() {
    return agreement.version;
  },
}));

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

/**
 * The default table from fenro T-472 (plus "Manage departments and locations"
 * from T-473), in the order Owner, Self, Colleague, External worker, Group
 * admin, HR, Leadership, Org admin. A dash is a cell the table does not have.
 */
const DEFAULT_TABLE = `
CARD                             write read  read  read  read  write read  write
PHOTO                            write write read  read  read  write read  write
WORK_CONTACT                     write read  read  none  read  write read  write
JOB                              write read  none  none  read  write read  write
CONTACT                          write write none  none  none  write none  write
PERSONAL                         write write none  none  none  write none  write
CREATE_ACCOUNTLESS_PERSON        allowed - - - no allowed no allowed
SEND_DIRECTORY_INVITE            allowed - - - no allowed no allowed
CHANGE_WORKER_TYPE               allowed - - - no allowed no allowed
END_EMPLOYMENT                   allowed - - - - allowed no allowed
MANAGE_DEPARTMENTS_AND_LOCATIONS allowed - - - no allowed no allowed
`;

const AUDIENCE_ORDER = [
  "OWNER",
  "SELF",
  "COLLEAGUE",
  "EXTERNAL_WORKER",
  "GROUP_ADMIN",
  "HR",
  "LEADERSHIP",
  "ORGANIZATION_ADMIN",
];

const expectedCells = () =>
  DEFAULT_TABLE.trim()
    .split("\n")
    .flatMap((line) => {
      const [row, ...values] = line.trim().split(/\s+/);
      return values.flatMap((value, index) =>
        value === "-" ? [] : [`${row}/${AUDIENCE_ORDER[index]}=${value.toUpperCase()}`]
      );
    })
    .sort();

const storedCells = async (organizationId: string) =>
  (
    await db
      .select()
      .from(directoryPermissionCells)
      .where(eq(directoryPermissionCells.organizationId, organizationId))
  )
    .map((cell) => `${cell.row}/${cell.audience}=${cell.value}`)
    .sort();

describe("Turning the people directory on", () => {
  let server: LoopbackServer;

  beforeAll(async () => {
    await cleanupTestData();
    server = await listenOnLoopback(createServer());
  });

  beforeEach(() => {
    agreement.version = 1;
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  /**
   * Olga owns an organization with the group Support, where Jana is a member
   * and Dana a member holding an org-admin grant. Petra left earlier.
   */
  const setUp = async (plan: "FREE" | "PRO" | "ENTERPRISE" | "CUSTOM" = "ENTERPRISE") => {
    const owner = await makeUser("Olga Owner");
    const member = await makeUser("Jana Member");
    const delegate = await makeUser("Dana Delegate");
    const leaver = await makeUser("Petra Leaver");
    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    const support = await makeGroup("Support", owner.id, { organizationOwnerId: owner.id });
    for (const person of [member, delegate, leaver]) {
      await addMember(support, person.id);
      await syncEmployment(organizationId, person.id);
    }
    await syncEmployment(organizationId, owner.id);
    await db.insert(organizationUsers).values({
      id: generateRandomUUID(),
      organizationId,
      userId: delegate.id,
      grantedByUserId: owner.id,
    });
    await db
      .update(employments)
      .set({ endedAt: new Date("2026-01-31T12:00:00Z") })
      .where(eq(employments.userId, leaver.id));

    if (plan === "PRO" || plan === "ENTERPRISE") {
      await upsertSubscription(organizationId, {
        plan: plan === "PRO" ? subscriptionPlan.Pro : subscriptionPlan.Enterprise,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });
    }
    if (plan === "CUSTOM") {
      await upsertSubscription(organizationId, { manualPlanOverride: manualPlanOverride.Custom });
    }

    return { owner, member, delegate, organizationId };
  };

  const as = (userId: string) => apiAs(server.url, userId);

  const enablePath = (organizationId: string) =>
    `/api/organization/directory/enable?organizationId=${organizationId}`;

  it("writes the settings row, an acceptance row and the default Permission table in one go", async () => {
    const { owner, organizationId } = await setUp();
    const olga = await as(owner.id);

    const res = await olga.post(enablePath(organizationId), { agreementVersion: 1 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      organizationId,
      isOwner: true,
      enabled: true,
      writable: true,
      agreement: {
        currentVersion: 1,
        acceptedVersion: 1,
        acceptedByName: "Olga Owner",
        newVersionReady: false,
      },
      people: { open: 3, former: 1 },
    });

    const [settings] = await db
      .select()
      .from(organizationDirectorySettings)
      .where(eq(organizationDirectorySettings.organizationId, organizationId));
    expect(settings).toMatchObject({ enabled: true, enabledByUserId: owner.id });
    expect(settings!.enabledAt).toBeInstanceOf(Date);

    const acceptances = await db
      .select()
      .from(directoryAgreementAcceptances)
      .where(eq(directoryAgreementAcceptances.organizationId, organizationId));
    expect(acceptances).toEqual([
      expect.objectContaining({ version: 1, acceptedByUserId: owner.id }),
    ]);

    expect(await storedCells(organizationId)).toEqual(expectedCells());
  });

  it("writes none of the three when the table copy fails", async () => {
    const { owner, organizationId } = await setUp();
    await db.execute(sql`
      create or replace function directory_cells_fail() returns trigger language plpgsql as
      $$ begin raise exception 'cell insert refused'; end $$`);
    await db.execute(sql`
      create trigger directory_cells_fail before insert on directory_permission_cells
      for each statement execute function directory_cells_fail()`);
    try {
      const res = await (
        await as(owner.id)
      ).post(enablePath(organizationId), {
        agreementVersion: 1,
      });
      expect(res.status).toBe(500);
    } finally {
      await db.execute(sql`drop trigger directory_cells_fail on directory_permission_cells`);
      await db.execute(sql`drop function directory_cells_fail()`);
    }

    expect(
      await db
        .select()
        .from(organizationDirectorySettings)
        .where(eq(organizationDirectorySettings.organizationId, organizationId))
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(directoryAgreementAcceptances)
        .where(eq(directoryAgreementAcceptances.organizationId, organizationId))
    ).toEqual([]);
  });

  it("refuses an agreement version the owner was not shown", async () => {
    const { owner, organizationId } = await setUp();
    const res = await (
      await as(owner.id)
    ).post(enablePath(organizationId), {
      agreementVersion: 2,
    });

    expect(res.status).toBe(409);
    expect(res.body.errors[0].context.code).toBe("AGREEMENT_VERSION_STALE");
    expect(await storedCells(organizationId)).toEqual([]);
  });

  it.each(["ENTERPRISE", "CUSTOM"] as const)("lets the owner turn it on on %s", async (plan) => {
    const { owner, organizationId } = await setUp(plan);
    const res = await (
      await as(owner.id)
    ).post(enablePath(organizationId), {
      agreementVersion: 1,
    });
    expect(res.status).toBe(200);
  });

  it.each(["FREE", "PRO"] as const)("refuses %s with a 402 and writes nothing", async (plan) => {
    const { owner, organizationId } = await setUp(plan);
    const res = await (
      await as(owner.id)
    ).post(enablePath(organizationId), {
      agreementVersion: 1,
    });

    expect(res.status).toBe(402);
    expect(res.body.errors[0].context).toMatchObject({
      reason: "PLAN_LIMIT",
      code: "DIRECTORY_PLAN_REQUIRED",
    });
    expect(await storedCells(organizationId)).toEqual([]);
  });

  it("refuses an org admin with a 403, and a member who administers nothing too", async () => {
    const { member, delegate, organizationId } = await setUp();

    const byDelegate = await (
      await as(delegate.id)
    ).post(enablePath(organizationId), {
      agreementVersion: 1,
    });
    expect(byDelegate.status).toBe(403);
    expect(byDelegate.body.errors[0].context.code).toBe("OWNER_ONLY");

    const byMember = await (
      await as(member.id)
    ).post(enablePath(organizationId), {
      agreementVersion: 1,
    });
    expect(byMember.status).toBe(403);
    expect(await storedCells(organizationId)).toEqual([]);
  });

  it("shows the org admin the state but not the switch", async () => {
    const { owner, delegate, organizationId } = await setUp();
    await (await as(owner.id)).post(enablePath(organizationId), { agreementVersion: 1 });

    const res = await (
      await as(delegate.id)
    ).get(`/api/organization/directory?organizationId=${organizationId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ isOwner: false, enabled: true });

    const disable = await (
      await as(delegate.id)
    ).post(`/api/organization/directory/disable?organizationId=${organizationId}`);
    expect(disable.status).toBe(403);
  });

  it("refuses a second enable while it is on", async () => {
    const { owner, organizationId } = await setUp();
    const olga = await as(owner.id);
    await olga.post(enablePath(organizationId), { agreementVersion: 1 });

    const again = await olga.post(enablePath(organizationId), { agreementVersion: 1 });
    expect(again.status).toBe(409);
    expect(again.body.errors[0].context.code).toBe("DIRECTORY_ALREADY_ON");
  });

  it("turns off on a lapsed plan, keeps the table, and a re-enable brings the stored cells back", async () => {
    const { owner, organizationId } = await setUp();
    const olga = await as(owner.id);
    await olga.post(enablePath(organizationId), { agreementVersion: 1 });
    await db
      .update(directoryPermissionCells)
      .set({ value: directoryPermissionValue.None })
      .where(eq(directoryPermissionCells.organizationId, organizationId));
    await db
      .delete(directoryPermissionCells)
      .where(
        eq(directoryPermissionCells.row, directoryPermissionRow.ManageDepartmentsAndLocations)
      );
    await upsertSubscription(organizationId, {
      status: subscriptionStatus.Canceled,
      graceEndsAt: new Date(0),
    });

    const off = await olga.post(
      `/api/organization/directory/disable?organizationId=${organizationId}`
    );
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ enabled: false, writable: false });
    expect((await storedCells(organizationId)).length).toBe(67);

    const refused = await olga.post(enablePath(organizationId), { agreementVersion: 1 });
    expect(refused.status).toBe(402);

    await upsertSubscription(organizationId, {
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });
    const on = await olga.post(enablePath(organizationId), { agreementVersion: 1 });
    expect(on.status).toBe(200);

    const cells = await db
      .select()
      .from(directoryPermissionCells)
      .where(eq(directoryPermissionCells.organizationId, organizationId));
    const manage = cells.filter(
      (cell) => cell.row === directoryPermissionRow.ManageDepartmentsAndLocations
    );
    const kept = cells.filter(
      (cell) => cell.row !== directoryPermissionRow.ManageDepartmentsAndLocations
    );
    expect(kept.every((cell) => cell.value === directoryPermissionValue.None)).toBe(true);
    expect(manage.map((cell) => `${cell.audience}=${cell.value}`).sort()).toEqual([
      `${directoryAudience.GroupAdmin}=NO`,
      `${directoryAudience.Hr}=ALLOWED`,
      `${directoryAudience.Leadership}=NO`,
      `${directoryAudience.OrganizationAdmin}=ALLOWED`,
      `${directoryAudience.Owner}=ALLOWED`,
    ]);

    const acceptances = await db
      .select()
      .from(directoryAgreementAcceptances)
      .where(eq(directoryAgreementAcceptances.organizationId, organizationId));
    expect(acceptances).toHaveLength(2);
  });

  describe("a new agreement version", () => {
    it("tells only the owner, pauses nothing, and clears once accepted", async () => {
      const { owner, delegate, member, organizationId } = await setUp();
      const olga = await as(owner.id);
      await olga.post(enablePath(organizationId), { agreementVersion: 1 });
      await upsertSubscription(organizationId, {
        status: subscriptionStatus.Canceled,
        graceEndsAt: new Date(0),
      });

      agreement.version = 2;

      const state = await olga.get(`/api/organization/directory?organizationId=${organizationId}`);
      expect(state.body).toMatchObject({
        enabled: true,
        agreement: { currentVersion: 2, acceptedVersion: 1, newVersionReady: true },
      });

      const ownerOrgs = await olga.get("/api/directory/organizations");
      expect(ownerOrgs.body).toEqual([
        expect.objectContaining({ organizationId, role: "OWNER", newAgreementVersionReady: true }),
      ]);
      const delegateState = await (
        await as(delegate.id)
      ).get(`/api/organization/directory?organizationId=${organizationId}`);
      expect(delegateState.status).toBe(200);
      expect(delegateState.body.agreement).toMatchObject({
        currentVersion: 2,
        acceptedVersion: 1,
        newVersionReady: false,
      });

      for (const viewer of [delegate, member]) {
        const orgs = await (await as(viewer.id)).get("/api/directory/organizations");
        expect(orgs.body).toEqual([
          expect.objectContaining({
            organizationId,
            enabled: true,
            newAgreementVersionReady: false,
          }),
        ]);
      }

      const stale = await olga.post(
        `/api/organization/directory/agreement?organizationId=${organizationId}`,
        { agreementVersion: 1 }
      );
      expect(stale.status).toBe(409);

      const accepted = await olga.post(
        `/api/organization/directory/agreement?organizationId=${organizationId}`,
        { agreementVersion: 2 }
      );
      expect(accepted.status).toBe(200);
      expect(accepted.body.agreement).toMatchObject({
        acceptedVersion: 2,
        newVersionReady: false,
      });
    });

    it("refuses an acceptance from an org admin", async () => {
      const { owner, delegate, organizationId } = await setUp();
      await (await as(owner.id)).post(enablePath(organizationId), { agreementVersion: 1 });
      agreement.version = 2;

      const res = await (
        await as(delegate.id)
      ).post(`/api/organization/directory/agreement?organizationId=${organizationId}`, {
        agreementVersion: 2,
      });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/directory/organizations", () => {
    it("lists owned, administered and employing organizations with their roles", async () => {
      const { owner, member, delegate, organizationId } = await setUp("PRO");

      const forOwner = await (await as(owner.id)).get("/api/directory/organizations");
      expect(forOwner.body).toEqual([
        expect.objectContaining({ organizationId, role: "OWNER", enabled: false, writable: false }),
      ]);
      const forDelegate = await (await as(delegate.id)).get("/api/directory/organizations");
      expect(forDelegate.body).toEqual([
        expect.objectContaining({ organizationId, role: "ORGANIZATION_ADMIN" }),
      ]);
      const forMember = await (await as(member.id)).get("/api/directory/organizations");
      expect(forMember.body).toEqual([
        expect.objectContaining({ organizationId, role: "MEMBER", enabled: false }),
      ]);
    });

    it("leaves out an organization the person has left", async () => {
      const leaver = await makeUser("Lea Leaver");
      const owner = await makeUser("Otto Owner");
      const organizationId = (await ensureOrganizationForUser(owner.id)).id;
      await db.insert(employments).values({
        id: generateRandomUUID(),
        organizationId,
        userId: leaver.id,
        name: "Lea Leaver",
        endedAt: new Date(),
      });

      const res = await (await as(leaver.id)).get("/api/directory/organizations");
      expect(res.body).toEqual([]);
    });
  });

  it("support detail shows the directory without a Profile field", async () => {
    const { owner, organizationId } = await setUp();
    await (await as(owner.id)).post(enablePath(organizationId), { agreementVersion: 1 });

    const detail = await getOrganizationDetailForSupport(organizationId);

    expect(detail!.directory).toEqual({
      enabled: true,
      enabledAt: expect.any(Date),
      disabledAt: null,
      currentAgreementVersion: 1,
      acceptedAgreementVersion: 1,
      acceptedAt: expect.any(Date),
      acceptances: 1,
      permissionCells: 72,
      people: { open: 3, former: 1 },
    });
  });
});

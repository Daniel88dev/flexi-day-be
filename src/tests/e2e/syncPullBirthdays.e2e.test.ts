import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import {
  subscriptionPlan,
  subscriptions,
  subscriptionStatus,
} from "../../db/schema/subscription-schema.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { removeBirthday, saveBirthday } from "../../services/birthday/birthdayServices.js";
import { encodeSyncCursor } from "../../services/sync/syncCursor.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addMember,
  ageEverything,
  makeGroup,
  makeUser,
  removeMember,
  resetReportData,
} from "./helpers/reportFixtures.js";

type BirthdayRow = {
  id: string;
  userId: string;
  month: number | null;
  day: number | null;
  year: number | null;
  shared: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type SyncBody = {
  reset: boolean;
  hasMore: boolean;
  users: { id: string }[];
  groupUsers: { userId: string; deletedAt: string | null }[];
  birthdays: BirthdayRow[];
};

const MINUTE = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE;

/** Old enough that only a change made after `ageEverything` lands in the window. */
const staleCursor = (): string => encodeSyncCursor(new Date(Date.now() - 10 * MINUTE));

const organizationOf = async (managerId: string) => (await ensureOrganizationForUser(managerId)).id;

const makePaid = async (managerId: string) =>
  upsertSubscription(await organizationOf(managerId), {
    plan: subscriptionPlan.Pro,
    status: subscriptionStatus.Active,
    graceEndsAt: null,
  });

const userIdsOf = (rows: BirthdayRow[]) => rows.map((row) => row.userId).sort();

describe("Sync pull birthdays E2E", () => {
  let server: LoopbackServer;

  const pull = async (userId: string, cursor?: string): Promise<SyncBody> => {
    const call = request(server.url)
      .get("/api/sync/pull")
      .set("Cookie", await authCookieFor(userId));
    const res = await (cursor === undefined ? call : call.query({ cursor })).expect(200);
    return res.body as SyncBody;
  };

  /** A group the viewer sees in full, with a colleague who shares a birthday. */
  const seedGroup = async (options: { paid: boolean } = { paid: true }) => {
    const manager = await makeUser("Manager");
    const viewer = await makeUser("Viewer");
    const colleague = await makeUser("Colleague");
    const groupId = await makeGroup("Engineering", manager.id);
    await addMember(groupId, viewer.id, { viewAccess: true });
    await addMember(groupId, colleague.id);
    if (options.paid) await makePaid(manager.id);
    await saveBirthday(colleague.id, { month: 2, day: 29, year: 1992, shared: true });
    return { manager, viewer, colleague, groupId };
  };

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    await resetReportData();
  });

  afterAll(async () => {
    await server?.close();
    await resetReportData();
  });

  describe("a snapshot", () => {
    it("ships the caller's own birthday and the visible shared ones, keyed by user", async () => {
      const { viewer, colleague, groupId } = await seedGroup();
      const quiet = await makeUser("Quiet");
      await addMember(groupId, quiet.id);
      await saveBirthday(quiet.id, { month: 6, day: 1, year: null, shared: false });
      await saveBirthday(viewer.id, { month: 3, day: 9, year: null, shared: false });

      const body = await pull(viewer.id);

      expect(body.reset).toBe(true);
      expect(userIdsOf(body.birthdays)).toEqual([colleague.id, viewer.id].sort());
      expect(body.birthdays.find((row) => row.userId === colleague.id)).toEqual({
        id: colleague.id,
        userId: colleague.id,
        month: 2,
        day: 29,
        year: 1992,
        shared: true,
        deletedAt: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(body.birthdays.find((row) => row.userId === viewer.id)).toMatchObject({
        month: 3,
        day: 9,
        year: null,
        shared: false,
      });
    });

    it("ships no colleague's birthday from a group whose organization never paid", async () => {
      const { viewer } = await seedGroup({ paid: false });

      expect((await pull(viewer.id)).birthdays).toEqual([]);
    });

    it("ships no colleague's birthday to a plain member", async () => {
      const { colleague, groupId } = await seedGroup();
      const plain = await makeUser("Plain");
      await addMember(groupId, plain.id);

      expect((await pull(plain.id)).birthdays).toEqual([]);
      expect(userIdsOf((await pull(colleague.id)).birthdays)).toEqual([colleague.id]);
    });

    it("leaves out removed birthdays", async () => {
      const { viewer, colleague } = await seedGroup();
      await removeBirthday(colleague.id);

      expect((await pull(viewer.id)).birthdays).toEqual([]);
    });
  });

  describe("a delta", () => {
    it("ships the tombstone after a colleague removes their birthday", async () => {
      const { viewer, colleague } = await seedGroup();
      await ageEverything();
      await removeBirthday(colleague.id);

      const body = await pull(viewer.id, staleCursor());

      expect(body.reset).toBe(false);
      expect(body.birthdays).toEqual([
        expect.objectContaining({
          id: colleague.id,
          month: null,
          day: null,
          year: null,
          deletedAt: expect.any(String),
        }),
      ]);
    });

    it("ships a tombstone-shaped row, without the date, when a colleague stops sharing", async () => {
      const { viewer, colleague } = await seedGroup();
      await ageEverything();
      await saveBirthday(colleague.id, { month: 2, day: 29, year: 1992, shared: false });

      const body = await pull(viewer.id, staleCursor());

      expect(body.reset).toBe(false);
      expect(body.birthdays).toHaveLength(1);
      const [row] = body.birthdays;
      expect(row).toMatchObject({
        id: colleague.id,
        userId: colleague.id,
        month: null,
        day: null,
        year: null,
        shared: false,
      });
      expect(row!.deletedAt).toBe(row!.updatedAt);
    });

    it("ships the caller's own row in full when they stop sharing it", async () => {
      const { colleague } = await seedGroup();
      await ageEverything();
      await saveBirthday(colleague.id, { month: 2, day: 29, year: 1992, shared: false });

      const body = await pull(colleague.id, staleCursor());

      expect(body.birthdays).toEqual([
        expect.objectContaining({
          id: colleague.id,
          month: 2,
          day: 29,
          shared: false,
          deletedAt: null,
        }),
      ]);
    });

    it("ships a changed shared birthday and nothing that did not change", async () => {
      const { viewer, colleague, groupId } = await seedGroup();
      const other = await makeUser("Other");
      await addMember(groupId, other.id);
      await saveBirthday(other.id, { month: 8, day: 8, year: null, shared: true });
      await ageEverything();
      await saveBirthday(colleague.id, { month: 3, day: 1, year: 1992, shared: true });

      const body = await pull(viewer.id, staleCursor());

      expect(body.reset).toBe(false);
      expect(body.birthdays).toEqual([
        expect.objectContaining({ id: colleague.id, month: 3, day: 1, deletedAt: null }),
      ]);
    });

    it("brings a joining colleague's shared birthday with their membership row", async () => {
      const { viewer, groupId } = await seedGroup();
      const joiner = await makeUser("Joiner");
      await saveBirthday(joiner.id, { month: 7, day: 4, year: 1985, shared: true });
      await ageEverything();
      await addMember(groupId, joiner.id);

      const body = await pull(viewer.id, staleCursor());

      expect(body.reset).toBe(false);
      expect(body.groupUsers.map((row) => row.userId)).toEqual([joiner.id]);
      expect(body.users.map((row) => row.id)).toContain(joiner.id);
      expect(body.birthdays).toEqual([
        expect.objectContaining({ id: joiner.id, month: 7, day: 4, year: 1985, deletedAt: null }),
      ]);
    });

    it("brings no birthday a joining colleague keeps to themselves", async () => {
      const { viewer, groupId } = await seedGroup();
      const joiner = await makeUser("Joiner");
      await ageEverything();
      await addMember(groupId, joiner.id);

      expect((await pull(viewer.id, staleCursor())).birthdays).toEqual([]);
    });

    it("tombstones a leaving colleague's birthday with their membership row", async () => {
      const { viewer, colleague, groupId } = await seedGroup();
      await ageEverything();
      await removeMember(groupId, colleague.id);

      const body = await pull(viewer.id, staleCursor());

      expect(body.reset).toBe(false);
      expect(body.birthdays).toEqual([
        expect.objectContaining({
          id: colleague.id,
          month: null,
          day: null,
          deletedAt: expect.any(String),
        }),
      ]);
    });

    it("keeps a leaving colleague's birthday live while another group still shows it", async () => {
      const { manager, viewer, colleague, groupId } = await seedGroup();
      const second = await makeGroup("Design", manager.id);
      await addMember(second, viewer.id, { viewAccess: true });
      await addMember(second, colleague.id);
      await ageEverything();
      await removeMember(groupId, colleague.id);

      const body = await pull(viewer.id, staleCursor());

      expect(body.birthdays).toEqual([
        expect.objectContaining({ id: colleague.id, month: 2, day: 29, deletedAt: null }),
      ]);
    });
  });

  describe("a plan change", () => {
    it("answers a reset whose snapshot carries the birthdays once a never-paid organization upgrades", async () => {
      const { manager, viewer, colleague } = await seedGroup({ paid: false });
      expect((await pull(viewer.id)).birthdays).toEqual([]);
      await ageEverything();
      await makePaid(manager.id);

      const body = await pull(viewer.id, staleCursor());

      expect(body.reset).toBe(true);
      expect(userIdsOf(body.birthdays)).toEqual([colleague.id]);
    });

    it("removes nothing when the grace window runs out", async () => {
      const { manager, viewer, colleague } = await seedGroup({ paid: false });
      await upsertSubscription(await organizationOf(manager.id), {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Canceled,
        graceEndsAt: new Date(Date.now() + DAY_MS),
      });
      expect(userIdsOf((await pull(viewer.id)).birthdays)).toEqual([colleague.id]);
      await ageEverything();
      // Grace running out writes nothing: the row only ages past its `graceEndsAt`.
      await db
        .update(subscriptions)
        .set({ graceEndsAt: new Date(Date.now() - DAY_MS), updatedAt: new Date(0) })
        .where(eq(subscriptions.organizationId, await organizationOf(manager.id)));

      const delta = await pull(viewer.id, staleCursor());
      expect(delta.reset).toBe(false);
      expect(delta.birthdays).toEqual([]);

      expect(userIdsOf((await pull(viewer.id)).birthdays)).toEqual([colleague.id]);
    });
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/db.js";
import { employments } from "../../db/schema/employment-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { cleanupTestData, createTestUser } from "./helpers/testSetup.js";
import { getEmployment, listEmployments } from "../../services/employment/employmentServices.js";
import {
  createGroup,
  deleteGroup,
  updateGroupManager,
} from "../../services/group/groupServices.js";
import {
  createGroupUser,
  deleteGroupUser,
  getGroupUser,
} from "../../services/groupUser/groupUserServices.js";
import {
  ensureOrganizationForUser,
  grantOrganizationAdmin,
  removeOrganizationAdmin,
} from "../../services/organization/organizationServices.js";

const BACKFILL_MIGRATION = "src/db/schema/out/0008_employments.sql";

/**
 * The backfill as production ran it. Taken out of the migration rather than
 * reimplemented, so these assertions cannot pass against a second, tidier copy
 * that no database ever executed.
 */
const backfillEmployments = async () => {
  const migration = await readFile(resolve(process.cwd(), BACKFILL_MIGRATION), "utf8");
  const statement = migration
    .split("--> statement-breakpoint")
    .find((part) => part.includes('INSERT INTO "employments"'));

  if (!statement) {
    throw new Error(`${BACKFILL_MIGRATION} no longer carries the roster backfill`);
  }

  await db.execute(sql.raw(statement));
};

/**
 * The roster has to stay in step with four kinds of link, written by paths
 * that know nothing about each other (ADR 0004). These run against a real
 * database because the property being tested is precisely what the union of
 * those tables says at a given moment.
 */
describe("the employment roster", () => {
  let organizationId: string;
  let owner: { id: string };

  const userOf = async (slug: string) =>
    createTestUser(`roster-${slug}@test.com`, `Roster ${slug}`, "password123");

  const newGroup = async (name: string, managerUserId: string) => {
    const record = await createGroup({
      id: uuidv4(),
      organizationId,
      groupName: name,
      managerUserId,
    });
    return record!.id;
  };

  const addMember = async (groupId: string, userId: string) =>
    createGroupUser({ id: uuidv4(), groupId, userId, viewAccess: true, controlledUser: true });

  const removeMember = async (groupId: string, userId: string) => {
    const membership = await getGroupUser(userId, groupId);
    await deleteGroupUser(membership!.id);
  };

  const isEmployed = async (userId: string) =>
    (await getEmployment(organizationId, userId))?.endedAt === null;

  beforeAll(async () => {
    await cleanupTestData();
    owner = await userOf("owner");
    organizationId = (await ensureOrganizationForUser(owner.id)).id;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  describe("the one-time backfill", () => {
    it("gives every person reachable from an organization exactly one row", async () => {
      const delegate = await userOf("backfill-delegate");
      const manager = await userOf("backfill-manager");
      const member = await userOf("backfill-member");

      await grantOrganizationAdmin({
        organizationId,
        userId: delegate.id,
        grantedByUserId: owner.id,
      });
      const engineering = await newGroup("Backfill Engineering", manager.id);
      const support = await newGroup("Backfill Support", manager.id);
      await addMember(engineering, member.id);
      await addMember(support, member.id);

      // The live sync has already written these. Clearing them is what leaves
      // the backfill something to do, and it is the state production is in.
      await db.delete(employments).where(eq(employments.organizationId, organizationId));

      await backfillEmployments();

      const roster = await listEmployments(organizationId);
      expect(roster.map((row) => row.userId).sort()).toEqual(
        [owner.id, delegate.id, manager.id, member.id].sort()
      );
      expect(roster.every((row) => row.ended === false)).toBe(true);
    });

    it("stamps the oldest link rather than the moment it ran", async () => {
      const veteran = await userOf("backfill-veteran");
      const joined = new Date("2026-03-01T08:00:00.000Z");
      const groupId = await newGroup("Backfill Veterans", owner.id);

      await db.insert(groupUsers).values({
        id: uuidv4(),
        groupId,
        userId: veteran.id,
        viewAccess: true,
        controlledUser: true,
        createdAt: joined,
        updatedAt: joined,
      });
      await db
        .delete(employments)
        .where(
          and(eq(employments.organizationId, organizationId), eq(employments.userId, veteran.id))
        );

      await backfillEmployments();

      expect((await getEmployment(organizationId, veteran.id))?.startedAt).toEqual(joined);
    });

    it("leaves alone a row the live sync already wrote", async () => {
      const before = await getEmployment(organizationId, owner.id);

      await backfillEmployments();

      expect(await getEmployment(organizationId, owner.id)).toEqual(before);
    });
  });

  describe("joining", () => {
    it("employs the owner when the organization is created", async () => {
      const founder = await userOf("founder");

      const organization = await ensureOrganizationForUser(founder.id);

      expect((await getEmployment(organization.id, founder.id))?.endedAt).toBeNull();
    });

    it("employs a delegated admin who belongs to no group", async () => {
      const delegate = await userOf("delegate");

      await grantOrganizationAdmin({
        organizationId,
        userId: delegate.id,
        grantedByUserId: owner.id,
      });

      expect(await isEmployed(delegate.id)).toBe(true);
    });

    it("employs a group's manager when the group is created", async () => {
      const manager = await userOf("manager");

      await newGroup("Manager's Group", manager.id);

      expect(await isEmployed(manager.id)).toBe(true);
    });

    it("employs the incoming manager on a reassignment", async () => {
      const successor = await userOf("successor");
      const groupId = await newGroup("Handover", owner.id);

      await db.transaction((tx) => updateGroupManager(groupId, successor.id, tx));

      expect(await isEmployed(successor.id)).toBe(true);
    });

    it("employs someone added to a group", async () => {
      const joiner = await userOf("joiner");
      const groupId = await newGroup("Joiners", owner.id);

      await addMember(groupId, joiner.id);

      expect(await isEmployed(joiner.id)).toBe(true);
    });

    it("reopens an ended Employment rather than writing a second row", async () => {
      const returner = await userOf("returner");
      const groupId = await newGroup("Returners", owner.id);
      await addMember(groupId, returner.id);
      const first = await getEmployment(organizationId, returner.id);
      await removeMember(groupId, returner.id);

      await addMember(groupId, returner.id);

      const reopened = await getEmployment(organizationId, returner.id);
      expect(reopened?.id).toBe(first!.id);
      expect(reopened?.endedAt).toBeNull();
      // A new spell: attendance is measured from the return, not the first day.
      expect(reopened!.startedAt.getTime()).toBeGreaterThan(first!.startedAt.getTime());
    });

    it("does not restart the spell of someone joining a second group", async () => {
      const dualMember = await userOf("dual-join");
      const first = await newGroup("Dual A", owner.id);
      const second = await newGroup("Dual B", owner.id);
      await addMember(first, dualMember.id);
      const opened = await getEmployment(organizationId, dualMember.id);

      await addMember(second, dualMember.id);

      expect((await getEmployment(organizationId, dualMember.id))?.startedAt).toEqual(
        opened!.startedAt
      );
    });
  });

  describe("leaving", () => {
    it("ends the Employment of someone removed from their only group", async () => {
      const leaver = await userOf("leaver");
      const groupId = await newGroup("Leavers", owner.id);
      await addMember(groupId, leaver.id);

      await removeMember(groupId, leaver.id);

      expect(await isEmployed(leaver.id)).toBe(false);
    });

    it("keeps it open when one of two groups is left", async () => {
      const stayer = await userOf("stayer");
      const first = await newGroup("Stayers A", owner.id);
      const second = await newGroup("Stayers B", owner.id);
      await addMember(first, stayer.id);
      await addMember(second, stayer.id);

      await removeMember(first, stayer.id);

      expect(await isEmployed(stayer.id)).toBe(true);
    });

    it("ends it when the delegated admin grant was the last link", async () => {
      const revoked = await userOf("revoked");
      await grantOrganizationAdmin({
        organizationId,
        userId: revoked.id,
        grantedByUserId: owner.id,
      });

      await removeOrganizationAdmin(organizationId, revoked.id);

      expect(await isEmployed(revoked.id)).toBe(false);
    });

    it("keeps it open for a revoked admin who still belongs to a group", async () => {
      const demoted = await userOf("demoted");
      const groupId = await newGroup("Demoted", owner.id);
      await addMember(groupId, demoted.id);
      await grantOrganizationAdmin({
        organizationId,
        userId: demoted.id,
        grantedByUserId: owner.id,
      });

      await removeOrganizationAdmin(organizationId, demoted.id);

      expect(await isEmployed(demoted.id)).toBe(true);
    });

    it("ends it for a manager who hands over their only group", async () => {
      const outgoing = await userOf("outgoing");
      const incoming = await userOf("incoming");
      const groupId = await newGroup("Outgoing", outgoing.id);

      await db.transaction((tx) => updateGroupManager(groupId, incoming.id, tx));

      expect(await isEmployed(outgoing.id)).toBe(false);
      expect(await isEmployed(incoming.id)).toBe(true);
    });

    it("ends the whole group's Employments when the group is deleted", async () => {
      const manager = await userOf("doomed-manager");
      const member = await userOf("doomed-member");
      const groupId = await newGroup("Doomed", manager.id);
      await addMember(groupId, member.id);

      await db.transaction((tx) => deleteGroup(groupId, tx));

      expect(await isEmployed(manager.id)).toBe(false);
      expect(await isEmployed(member.id)).toBe(false);
    });

    it("spares the members of a deleted group who belong to another", async () => {
      const survivor = await userOf("survivor");
      const doomed = await newGroup("Doomed Too", owner.id);
      const other = await newGroup("Survivors", owner.id);
      await addMember(doomed, survivor.id);
      await addMember(other, survivor.id);

      await db.transaction((tx) => deleteGroup(doomed, tx));

      expect(await isEmployed(survivor.id)).toBe(true);
    });

    // Both link removals take the organization lock and both recompute from
    // the links that are left, so whichever runs second is the one that ends
    // the Employment — and it ends exactly once.
    it("ends it once when the last group and the admin grant go together", async () => {
      const both = await userOf("both-links");
      const groupId = await newGroup("Both Links", owner.id);
      await addMember(groupId, both.id);
      await grantOrganizationAdmin({
        organizationId,
        userId: both.id,
        grantedByUserId: owner.id,
      });

      await removeMember(groupId, both.id);
      expect(await isEmployed(both.id)).toBe(true);
      await removeOrganizationAdmin(organizationId, both.id);

      const ended = await getEmployment(organizationId, both.id);
      expect(ended?.endedAt).not.toBeNull();
      expect(await listEmployments(organizationId, { userIds: [both.id] })).toHaveLength(1);
    });
  });

  it("never gives one person two rows in one organization", async () => {
    const roster = await listEmployments(organizationId);
    const userIds = roster.map((row) => row.userId);

    expect(new Set(userIds).size).toBe(userIds.length);
  });

  it("scopes an Employment to its own organization", async () => {
    const outsider = await userOf("other-org-owner");
    const elsewhere = await ensureOrganizationForUser(outsider.id);

    expect(await getEmployment(organizationId, outsider.id)).toBeUndefined();
    expect(await getEmployment(elsewhere.id, outsider.id)).toBeDefined();
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { config } from "../../config.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { assistantModelCalls } from "../../db/schema/assistant-meter-schema.js";
import { assistantRejectedTurns } from "../../db/schema/assistant-schema.js";
import {
  aiConnectionDailyCalls,
  aiConnectionMemberDailyCalls,
} from "../../db/schema/ai-connection-usage-schema.js";
import {
  aiUsageOrganizationWeeks,
  aiUsageUserWeeks,
} from "../../db/schema/ai-usage-weeks-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import { aiConnectionsLevel, organizations } from "../../db/schema/organization-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { runAiUsageRetention } from "../../jobs/aiUsageRetentionJob.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { WEB_TEST_PASSWORD, createWebUser, webSessionCookieFor } from "./helpers/authHelper.js";
import { apiAs } from "./helpers/directoryWorld.js";
import { addMember, makeGroup, resetReportData } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

const ON = { assistantEnabled: true, aiConnectionsEnabled: true, previewOrganizationIds: [] };
const TEN_DOLLARS = 10_000_000;
const DAY_MS = 86_400_000;

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const ago = (days: number, from = new Date()) => new Date(from.getTime() - days * DAY_MS);
/** Monday of the UTC week holding `date`. */
const mondayOf = (date: Date) => {
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const sinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  return isoDay(new Date(midnight - sinceMonday * DAY_MS));
};

type Week = { weekStart: string; usedMicroUsd: number; limitReachedAt: string | null };
type WeekSplit = {
  weekStart: string;
  usedMicroUsd: number;
  people: { userId: string | null; name: string | null; assistantMicroUsd: number }[] | null;
};

/** Acme (Enterprise, both features on): Olga owns it, Jana and Ben are members. */
const seed = async () => {
  const olga = await createWebUser("Olga Owner");
  const jana = await createWebUser("Jana Member");
  const ben = await createWebUser("Ben Member");
  const group = await makeGroup("Team", olga.id, { organizationOwnerId: olga.id });
  const [organization] = await db
    .update(organizations)
    .set({ assistantEnabled: true, aiConnections: aiConnectionsLevel.Write })
    .where(eq(organizations.ownerUserId, olga.id))
    .returning({ id: organizations.id });
  await upsertSubscription(organization!.id, {
    plan: subscriptionPlan.Enterprise,
    status: subscriptionStatus.Active,
    graceEndsAt: null,
  });
  for (const person of [jana, ben]) await addMember(group, person.id);
  for (const person of [olga, jana, ben]) await syncEmployment(organization!.id, person.id);
  return { acmeId: organization!.id, olga, jana, ben };
};

describe("AI usage retention on the nightly tick", () => {
  let server: LoopbackServer;
  let s: Awaited<ReturnType<typeof seed>>;
  const savedSwitches = config.aiFeatures;
  const savedLimit = config.assistant.weeklyLimitMicroUsd;

  const clearUsage = async () => {
    await db.delete(assistantModelCalls);
    await db.delete(assistantRejectedTurns);
    await db.delete(aiConnectionDailyCalls);
    await db.delete(aiConnectionMemberDailyCalls);
    await db.delete(aiUsageUserWeeks);
    await db.delete(aiUsageOrganizationWeeks);
  };

  const spend = async (microUsd: number, createdAt: Date, userId: string | null = s.jana.id) => {
    const id = generateRandomUUID();
    await db.insert(assistantModelCalls).values({
      id,
      organizationId: s.acmeId,
      userId,
      purpose: "main",
      modelId: "claude-sonnet-5-5",
      priceVersion: "claude-sonnet-5-5@2026-11-01",
      status: "settled",
      reservedMicroUsd: microUsd,
      settledMicroUsd: microUsd,
      weekStart: mondayOf(createdAt),
      createdAt,
    });
    return id;
  };

  const usage = async () => {
    const res = await (
      await apiAs(server.url, s.olga.id)
    ).get(`/api/organization/ai/usage?organizationId=${s.acmeId}`);
    expect(res.status).toBe(200);
    return res.body as { assistant: { weeks: Week[] } };
  };

  const weekSplit = async (weekStart: string) => {
    const res = await (
      await apiAs(server.url, s.olga.id)
    ).get(`/api/organization/ai/usage/weeks/${weekStart}?organizationId=${s.acmeId}`);
    expect(res.status).toBe(200);
    return res.body as WeekSplit;
  };

  beforeAll(async () => {
    config.aiFeatures = { ...ON };
    config.assistant.weeklyLimitMicroUsd = TEN_DOLLARS;
    server = await listenOnLoopback(createServer());
    await cleanupTestData();
    await resetReportData();
    s = await seed();
  });

  beforeEach(clearUsage);

  afterAll(async () => {
    config.aiFeatures = savedSwitches;
    config.assistant.weeklyLimitMicroUsd = savedLimit;
    await server?.close();
    await clearUsage();
    await cleanupTestData();
    await resetReportData();
  });

  it("deletes a 91-day-old ledger row and keeps its week as a per-user total", async () => {
    const old = ago(91);
    const oldRow = await spend(6_000_000, old);
    await spend(4_500_000, new Date(old.getTime() + 60_000), s.ben.id);
    const recent = await spend(700_000, ago(1));

    await runAiUsageRetention();

    const ledger = await db.select({ id: assistantModelCalls.id }).from(assistantModelCalls);
    expect(ledger.map((row) => row.id)).toEqual([recent]);
    expect(ledger.map((row) => row.id)).not.toContain(oldRow);

    const split = await weekSplit(mondayOf(old));
    expect(split.usedMicroUsd).toBe(10_500_000);
    expect(split.people).toEqual([
      { userId: s.jana.id, name: "Jana Member", assistantMicroUsd: 6_000_000, refusedTurns: 0 },
      { userId: s.ben.id, name: "Ben Member", assistantMicroUsd: 4_500_000, refusedTurns: 0 },
    ]);

    const week = (await usage()).assistant.weeks.find((row) => row.weekStart === mondayOf(old));
    expect(week).toMatchObject({ usedMicroUsd: 10_500_000 });
    expect(week!.limitReachedAt).toBe(new Date(old.getTime() + 60_000).toISOString());
  });

  it("folds a 181-day-old per-user total into an organization total with no user", async () => {
    const old = ago(185);
    await spend(3_000_000, old);
    await spend(1_000_000, new Date(old.getTime() + 60_000), s.ben.id);

    await runAiUsageRetention(new Date(old.getTime() + 10 * DAY_MS));
    const perUser = await db
      .select({ userId: aiUsageUserWeeks.userId, used: aiUsageUserWeeks.usedMicroUsd })
      .from(aiUsageUserWeeks)
      .where(eq(aiUsageUserWeeks.weekStart, mondayOf(old)));
    expect(perUser).toHaveLength(2);
    expect(await db.select().from(assistantModelCalls)).toHaveLength(2);

    await runAiUsageRetention();

    expect(await db.select().from(assistantModelCalls)).toHaveLength(0);
    expect(await db.select().from(aiUsageUserWeeks)).toHaveLength(0);
    const organizationWeeks = await db
      .select({
        weekStart: aiUsageOrganizationWeeks.weekStart,
        used: aiUsageOrganizationWeeks.usedMicroUsd,
      })
      .from(aiUsageOrganizationWeeks)
      .where(eq(aiUsageOrganizationWeeks.organizationId, s.acmeId));
    expect(organizationWeeks).toEqual([{ weekStart: mondayOf(old), used: 4_000_000 }]);

    expect(await weekSplit(mondayOf(old))).toEqual({
      weekStart: mondayOf(old),
      usedMicroUsd: 4_000_000,
      people: null,
    });
  });

  it("keeps AI connection calls and refused turns on the same clock", async () => {
    const oldDay = isoDay(ago(91));
    await db.insert(aiConnectionDailyCalls).values([
      { organizationId: s.acmeId, day: oldDay, calls: 40 },
      { organizationId: s.acmeId, day: isoDay(ago(2)), calls: 5 },
    ]);
    await db.insert(aiConnectionMemberDailyCalls).values([
      { organizationId: s.acmeId, userId: s.jana.id, day: oldDay, calls: 30 },
      { organizationId: s.acmeId, userId: s.ben.id, day: oldDay, calls: 10 },
    ]);
    await db.insert(assistantRejectedTurns).values([
      {
        id: "rejected-old",
        organizationId: s.acmeId,
        userId: s.ben.id,
        reason: "attack",
        createdAt: ago(181),
      },
      {
        id: "rejected-kept",
        organizationId: s.acmeId,
        userId: s.ben.id,
        reason: "attack",
        createdAt: ago(100),
      },
    ]);

    await runAiUsageRetention();

    expect(
      await db.select({ day: aiConnectionDailyCalls.day }).from(aiConnectionDailyCalls)
    ).toEqual([{ day: isoDay(ago(2)) }]);
    expect(await db.select().from(aiConnectionMemberDailyCalls)).toHaveLength(0);
    const [organizationWeek] = await db
      .select({ calls: aiUsageOrganizationWeeks.aiConnectionCalls })
      .from(aiUsageOrganizationWeeks)
      .where(eq(aiUsageOrganizationWeeks.weekStart, mondayOf(ago(91))));
    expect(organizationWeek).toEqual({ calls: 40 });
    const perUser = await db
      .select({ userId: aiUsageUserWeeks.userId, calls: aiUsageUserWeeks.aiConnectionCalls })
      .from(aiUsageUserWeeks);
    expect(perUser).toEqual(
      expect.arrayContaining([
        { userId: s.jana.id, calls: 30 },
        { userId: s.ben.id, calls: 10 },
      ])
    );
    expect(
      (await db.select({ id: assistantRejectedTurns.id }).from(assistantRejectedTurns)).map(
        (row) => row.id
      )
    ).toEqual(["rejected-kept"]);
  });

  it("rolls the same week again without counting it twice", async () => {
    const lastWeek = ago(8);
    await spend(2_000_000, lastWeek);

    await runAiUsageRetention();
    await spend(500_000, new Date(lastWeek.getTime() + 60_000));
    await runAiUsageRetention();

    const rows = await db
      .select({ used: aiUsageUserWeeks.usedMicroUsd })
      .from(aiUsageUserWeeks)
      .where(eq(aiUsageUserWeeks.weekStart, mondayOf(lastWeek)));
    expect(rows).toEqual([{ used: 2_500_000 }]);
    const [organizationWeek] = await db
      .select({ used: aiUsageOrganizationWeeks.usedMicroUsd })
      .from(aiUsageOrganizationWeeks)
      .where(eq(aiUsageOrganizationWeeks.weekStart, mondayOf(lastWeek)));
    expect(organizationWeek).toEqual({ used: 2_500_000 });
  });

  describe("Erase", () => {
    const organizationTotals = async () =>
      (
        await db
          .select({
            weekStart: aiUsageOrganizationWeeks.weekStart,
            used: aiUsageOrganizationWeeks.usedMicroUsd,
            calls: aiUsageOrganizationWeeks.aiConnectionCalls,
          })
          .from(aiUsageOrganizationWeeks)
          .where(eq(aiUsageOrganizationWeeks.organizationId, s.acmeId))
      ).sort((a, b) => a.weekStart.localeCompare(b.weekStart));

    const rowsNaming = async (userId: string) => ({
      ledger: await db
        .select({ id: assistantModelCalls.id })
        .from(assistantModelCalls)
        .where(eq(assistantModelCalls.userId, userId)),
      weeks: await db
        .select({ id: aiUsageUserWeeks.id })
        .from(aiUsageUserWeeks)
        .where(eq(aiUsageUserWeeks.userId, userId)),
      calls: await db
        .select({ day: aiConnectionMemberDailyCalls.day })
        .from(aiConnectionMemberDailyCalls)
        .where(eq(aiConnectionMemberDailyCalls.userId, userId)),
      rejected: await db
        .select({ id: assistantRejectedTurns.id })
        .from(assistantRejectedTurns)
        .where(eq(assistantRejectedTurns.userId, userId)),
    });

    it("keeps the organization's weekly totals and leaves no row naming the person", async () => {
      const ben = s.ben;
      const old = ago(120);
      const lastWeek = ago(8);
      await spend(2_000_000, old, ben.id);
      await spend(1_000_000, old);
      await spend(3_000_000, lastWeek, ben.id);
      await spend(500_000, lastWeek);
      await db.insert(aiConnectionDailyCalls).values({
        organizationId: s.acmeId,
        day: isoDay(lastWeek),
        calls: 12,
      });
      await db.insert(aiConnectionMemberDailyCalls).values({
        organizationId: s.acmeId,
        userId: ben.id,
        day: isoDay(lastWeek),
        calls: 12,
      });
      await db.insert(assistantRejectedTurns).values({
        id: generateRandomUUID(),
        organizationId: s.acmeId,
        userId: ben.id,
        reason: "off_topic",
        createdAt: lastWeek,
      });
      await runAiUsageRetention(new Date(old.getTime() + 8 * DAY_MS));
      await runAiUsageRetention();
      const before = await organizationTotals();
      expect(before).toEqual([
        { weekStart: mondayOf(old), used: 3_000_000, calls: 0 },
        { weekStart: mondayOf(lastWeek), used: 3_500_000, calls: 12 },
      ]);

      const cookie = await webSessionCookieFor(server.url, ben.email);
      const deleted = await request(server.url)
        .post("/api/users/me/delete")
        .set("Cookie", cookie)
        .send({ password: WEB_TEST_PASSWORD });
      expect(deleted.status).toBe(204);
      const kept = await rowsNaming(ben.id);
      expect(kept.ledger).toHaveLength(1);
      expect(kept.weeks).toHaveLength(2);

      const [employment] = await db
        .select({ id: employments.id })
        .from(employments)
        .where(and(eq(employments.organizationId, s.acmeId), eq(employments.userId, ben.id)));
      const erased = await (
        await apiAs(server.url, s.olga.id)
      ).post(`/api/employment/${employment!.id}/erase`, { confirmName: "Ben Member" });
      expect(erased.status).toBe(204);

      expect(await organizationTotals()).toEqual(before);
      expect(await rowsNaming(ben.id)).toEqual({ ledger: [], weeks: [], calls: [], rejected: [] });
      const split = await weekSplit(mondayOf(lastWeek));
      expect(split.usedMicroUsd).toBe(3_500_000);
      expect(split.people).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ userId: null, name: null, assistantMicroUsd: 3_000_000 }),
        ])
      );

      await runAiUsageRetention();
      expect(await organizationTotals()).toEqual(before);
      expect(await rowsNaming(ben.id)).toEqual({ ledger: [], weeks: [], calls: [], rejected: [] });
    });
  });
});

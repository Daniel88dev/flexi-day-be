import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { assistantModelCalls } from "../../db/schema/assistant-meter-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { vacationEvents } from "../../db/schema/vacation-event-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { fakeDriver, fakeDriverControls } from "../../services/assistant/driver/fakeDriver.js";
import { clearProviderRefusal, reserveToolRound } from "../../services/assistant/meter/meter.js";
import { settleRelays } from "../../services/assistant/turnServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { apiAs } from "./helpers/directoryWorld.js";
import { addMember, addQuota, makeGroup, makeUser } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

const ON = { assistantEnabled: true, aiConnectionsEnabled: false, previewOrganizationIds: [] };
const year = new Date().getUTCFullYear();
const TEN_DOLLARS = 10_000_000;

type StreamEvent = { event: string; id: string | null; data: Record<string, unknown> };

const parseStream = (body: string): StreamEvent[] =>
  body
    .split("\n\n")
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const lines = chunk.split("\n");
      const field = (name: string) =>
        lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
      return {
        event: field("event") ?? "",
        id: field("id"),
        data: JSON.parse(field("data") ?? "{}") as Record<string, unknown>,
      };
    });

/** Acme: Enterprise with the Assistant on. Its owner, an org admin and four members. */
const seed = async () => {
  const owner = await makeUser("Acme Owner");
  const groupId = await makeGroup("Acme Team", owner.id, { organizationOwnerId: owner.id });
  const [organization] = await db
    .update(organizations)
    .set({ name: "Acme", assistantEnabled: true })
    .where(eq(organizations.ownerUserId, owner.id))
    .returning({ id: organizations.id });
  const organizationId = organization!.id;
  await syncEmployment(organizationId, owner.id);
  await upsertSubscription(organizationId, {
    plan: subscriptionPlan.Enterprise,
    status: subscriptionStatus.Active,
    graceEndsAt: null,
  });
  const join = async (name: string) => {
    const member = await makeUser(name);
    await addMember(groupId, member.id, { viewAccess: true });
    await syncEmployment(organizationId, member.id);
    await addQuota(groupId, member.id, year, { vacationDays: 20 });
    return member;
  };
  const admin = await join("Ada Admin");
  await db.insert(organizationUsers).values({
    id: generateRandomUUID(),
    organizationId,
    userId: admin.id,
    grantedByUserId: owner.id,
  });
  const members = [
    await join("Ann Member"),
    await join("Ben Member"),
    await join("Cid Member"),
    await join("Dee Member"),
  ];
  return { organizationId, owner, admin, members };
};

type WeeklyLimit = {
  percent: number;
  reached: boolean;
  resetsAt: string;
  usedMicroUsd: number | null;
  limitMicroUsd: number | null;
};

describe("The Assistant's meter and Weekly limit", () => {
  let server: LoopbackServer;
  let s: Awaited<ReturnType<typeof seed>>;
  const savedSwitches = config.aiFeatures;
  const savedLimit = config.assistant.weeklyLimitMicroUsd;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    config.aiFeatures = { ...ON };
    config.assistant.weeklyLimitMicroUsd = TEN_DOLLARS;
    fakeDriverControls.reset();
    fakeDriverControls.chunkDelayMs = 0;
    fakeDriverControls.stepDelayMs = 5;
    clearProviderRefusal();
    await db.delete(vacationEvents);
    await db.delete(userYearQuotas);
    await cleanupTestData();
    s = await seed();
  });

  afterEach(async () => {
    fakeDriverControls.release?.();
    fakeDriverControls.reset();
    await settleRelays();
    clearProviderRefusal();
  });

  afterAll(async () => {
    config.aiFeatures = savedSwitches;
    config.assistant.weeklyLimitMicroUsd = savedLimit;
    await server?.close();
    await db.delete(userYearQuotas);
    await cleanupTestData();
  });

  const as = (userId: string) => apiAs(server.url, userId);

  const openChat = async (userId: string) => {
    const res = await (
      await as(userId)
    ).post("/api/assistant/chats", {
      organizationId: s.organizationId,
    });
    expect(res.status).toBe(201);
    return (res.body as { chat: { id: string } }).chat.id;
  };

  const send = async (userId: string, chatId: string, text: string) =>
    fetch(`${server.url}/api/assistant/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: await authCookieFor(userId) },
      body: JSON.stringify({ text }),
    });

  const mainSteps = async () => (await ledger()).filter((row) => row.purpose === "main");

  const ledger = () =>
    db
      .select()
      .from(assistantModelCalls)
      .where(eq(assistantModelCalls.organizationId, s.organizationId))
      .orderBy(assistantModelCalls.createdAt);

  /** Settled plus reserved for this week, straight from the ledger. */
  const usedInLedger = async () =>
    (await ledger())
      .filter((row) => row.weekStart === currentWeekStart())
      .reduce(
        (sum, row) =>
          sum + (row.status === "settled" ? row.settledMicroUsd! : row.reservedMicroUsd),
        0
      );

  const currentWeekStart = () => {
    const now = new Date();
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    return monday.toISOString().slice(0, 10);
  };

  const seedUsage = async (
    microUsd: number,
    options: { status?: "settled" | "reserved"; weekStart?: string; userId?: string } = {}
  ) => {
    const status = options.status ?? "settled";
    await db.insert(assistantModelCalls).values({
      id: generateRandomUUID(),
      organizationId: s.organizationId,
      userId: options.userId ?? s.owner.id,
      purpose: "main",
      modelId: "claude-sonnet-5-5",
      priceVersion: "claude-sonnet-5-5@2026-11-01",
      status,
      reservedMicroUsd: microUsd,
      settledMicroUsd: status === "settled" ? microUsd : null,
      ...(options.weekStart ? { weekStart: options.weekStart } : {}),
    });
  };

  const weeklyLimitFor = async (userId: string) => {
    const res = await (await as(userId)).get("/api/assistant/organizations");
    expect(res.status).toBe(200);
    const body = res.body as {
      providerUnavailable: boolean;
      organizations: { organizationId: string; weeklyLimit: WeeklyLimit | null }[];
    };
    return {
      providerUnavailable: body.providerUnavailable,
      weeklyLimit: body.organizations.find((o) => o.organizationId === s.organizationId)!
        .weeklyLimit!,
    };
  };

  const detail = async (userId: string, chatId: string) => {
    const res = await (await as(userId)).get(`/api/assistant/chats/${chatId}`);
    expect(res.status).toBe(200);
    return res.body as {
      chat: { turnRunning: boolean };
      messages: {
        kind: string;
        text: string | null;
        toolOutcome: string | null;
        code: string | null;
      }[];
    };
  };

  it("never lets concurrent turns in one organization push settled plus reserved past the limit", async () => {
    // A first step reserves about $0.084 (a 16k prompt written to the cache plus 4,096 output
    // tokens), so $0.21 has room for two open steps and not a third.
    const limit = 210_000;
    config.assistant.weeklyLimitMicroUsd = limit;
    const senders = [s.admin, ...s.members];
    const chats = await Promise.all(senders.map((member) => openChat(member.id)));

    const release = fakeDriverControls.hold();
    const responses = await Promise.all(
      senders.map((member, i) => send(member.id, chats[i]!, "Hello there"))
    );

    const accepted = responses.filter((res) => res.status === 200);
    const refused = responses.filter((res) => res.status === 429);
    expect(accepted).toHaveLength(2);
    expect(refused).toHaveLength(3);
    for (const res of refused) {
      const body = (await res.json()) as {
        errors: { context: { code: string; resetsAt: string } }[];
      };
      expect(body.errors[0]!.context.code).toBe("ASSISTANT_WEEKLY_LIMIT_REACHED");
      expect(new Date(body.errors[0]!.context.resetsAt).getUTCDay()).toBe(1);
    }

    // Both accepted steps are open at once, held before the model answers.
    const open = await mainSteps();
    expect(open.map((row) => row.status)).toEqual(["reserved", "reserved"]);
    const reserved = await usedInLedger();
    expect(reserved).toBeLessThanOrEqual(limit);
    expect((await weeklyLimitFor(s.owner.id)).weeklyLimit.usedMicroUsd).toBe(reserved);

    release();
    for (const res of accepted) {
      const events = parseStream(await res.text());
      expect(events.at(-1)!.event).toBe("done");
    }
    await settleRelays();

    const settled = await mainSteps();
    expect(settled.map((row) => row.status)).toEqual(["settled", "settled"]);
    for (const row of settled) {
      expect(row.settledMicroUsd!).toBeGreaterThan(0);
      expect(row.settledMicroUsd!).toBeLessThan(row.reservedMicroUsd);
      expect(row.purpose).toBe("main");
      expect(row.priceVersion).toBe("claude-sonnet-5-5@2026-11-01");
      expect(row.cacheWrite5mTokens).toBeGreaterThan(7713);
    }
    expect(await usedInLedger()).toBeLessThanOrEqual(limit);
    expect((await weeklyLimitFor(s.owner.id)).weeklyLimit.usedMicroUsd).toBe(await usedInLedger());
  });

  it("refuses a turn at the limit before anything is written or charged", async () => {
    const [ann] = s.members;
    const chatId = await openChat(ann!.id);
    await seedUsage(TEN_DOLLARS - 100);

    const res = await send(ann!.id, chatId, "How many vacation days do I have left?");

    expect(res.status).toBe(429);
    const body = (await res.json()) as { errors: { context: { code: string } }[] };
    expect(body.errors[0]!.context.code).toBe("ASSISTANT_WEEKLY_LIMIT_REACHED");
    expect(await ledger()).toHaveLength(1);
    expect(await usedInLedger()).toBe(TEN_DOLLARS - 100);
    const after = await detail(ann!.id, chatId);
    expect(after.messages).toEqual([]);
    expect(after.chat.turnRunning).toBe(false);
  });

  it("shows used as settled plus reserved this week: amounts to owners and admins, the percentage to members", async () => {
    await seedUsage(5_000_000);
    await seedUsage(3_500_000, { status: "reserved" });
    const lastMonday = new Date(`${currentWeekStart()}T00:00:00Z`);
    lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);
    await seedUsage(9_000_000, { weekStart: lastMonday.toISOString().slice(0, 10) });

    const owner = await weeklyLimitFor(s.owner.id);
    expect(owner.weeklyLimit).toMatchObject({
      percent: 85,
      reached: false,
      usedMicroUsd: 8_500_000,
      limitMicroUsd: TEN_DOLLARS,
    });
    const nextMonday = new Date(`${currentWeekStart()}T00:00:00Z`);
    nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);
    expect(owner.weeklyLimit.resetsAt).toBe(nextMonday.toISOString());

    expect((await weeklyLimitFor(s.admin.id)).weeklyLimit.usedMicroUsd).toBe(8_500_000);
    expect((await weeklyLimitFor(s.members[0]!.id)).weeklyLimit).toEqual({
      percent: 85,
      reached: false,
      resetsAt: nextMonday.toISOString(),
      usedMicroUsd: null,
      limitMicroUsd: null,
    });

    await seedUsage(1_450_000);
    expect((await weeklyLimitFor(s.members[0]!.id)).weeklyLimit).toMatchObject({
      percent: 99,
      reached: true,
    });
  });

  it("ends a turn refused mid-way with the fixed message and keeps what it streamed", async () => {
    const [ann, ben] = s.members;
    const chatId = await openChat(ann!.id);
    fakeDriverControls.leadText = "Let me look at your balance.";

    const release = fakeDriverControls.hold();
    const res = await send(ann!.id, chatId, "How many vacation days do I have left?");
    expect(res.status).toBe(200);
    // Another member's answers use the rest of the week while this step runs.
    const [step] = await mainSteps();
    await seedUsage(TEN_DOLLARS - step!.reservedMicroUsd - 1_000, { userId: ben!.id });
    release();

    const events = parseStream(await res.text());
    const texts = events.filter((e) => e.event === "text" && e.id !== null);
    expect(texts.map((e) => e.data.text)).toEqual(["Let me look at your balance."]);
    expect(events.filter((e) => e.event === "tool").map((e) => e.data.status)).toEqual(["running"]);
    expect(events.slice(-2).map((e) => [e.event, e.data.code])).toEqual([
      ["error", "ASSISTANT_WEEKLY_LIMIT_REACHED"],
      ["done", undefined],
    ]);
    await settleRelays();

    const after = await detail(ann!.id, chatId);
    expect(after.chat.turnRunning).toBe(false);
    expect(after.messages.map((m) => [m.kind, m.text, m.toolOutcome, m.code])).toEqual([
      ["user", "How many vacation days do I have left?", null, null],
      ["assistant", "Let me look at your balance.", null, null],
      ["tool", null, "stopped", null],
      ["notice", null, null, "ASSISTANT_WEEKLY_LIMIT_REACHED"],
    ]);
    // The first step settled; the refused one wrote no Usage, and the session never ran it.
    const rows = (await mainSteps()).filter((row) => row.chatId === chatId);
    expect(rows.map((row) => row.status)).toEqual(["settled"]);
    expect(await usedInLedger()).toBeLessThanOrEqual(TEN_DOLLARS);
    const sessionEvents = fakeDriverControls.events(rows[0]!.sessionId!);
    expect(sessionEvents.filter((e) => e.type === "span.model_request_start")).toHaveLength(1);
    expect(sessionEvents.some((e) => e.type === "user.interrupt")).toBe(false);
    expect(sessionEvents.some((e) => e.type === "user.custom_tool_result")).toBe(false);

    // The week resets; the next admitted message carries the held result ahead of itself.
    await db.delete(assistantModelCalls).where(eq(assistantModelCalls.userId, ben!.id));
    const thanks = await send(ann!.id, chatId, "Thanks");
    expect(thanks.status).toBe(200);
    await thanks.text();
    await settleRelays();
    const log = fakeDriverControls.events(rows[0]!.sessionId!);
    const carried = log.findIndex((e) => e.type === "user.custom_tool_result");
    expect(carried).toBeGreaterThan(-1);
    expect(carried).toBeLessThan(log.findLastIndex((e) => e.type === "user.message"));
  });

  it("settles both steps of a turn with a tool call from the session's usage", async () => {
    const [ann] = s.members;
    const chatId = await openChat(ann!.id);

    const res = await send(ann!.id, chatId, "How many vacation days do I have left?");
    expect(parseStream(await res.text()).at(-1)!.event).toBe("done");
    await settleRelays();

    const rows = (await mainSteps()).filter((row) => row.chatId === chatId);
    expect(rows.map((row) => [row.purpose, row.status])).toEqual([
      ["main", "settled"],
      ["main", "settled"],
    ]);
    const sessionId = rows[0]!.sessionId!;
    const usage = await fakeDriver.readUsage(sessionId);
    const sum = (key: "cacheWrite5mTokens" | "cacheReadTokens" | "outputTokens") =>
      rows.reduce((total, row) => total + row[key]!, 0);
    expect(sum("cacheWrite5mTokens")).toBe(usage.cache_creation.ephemeral_5m_input_tokens);
    expect(sum("cacheReadTokens")).toBe(usage.cache_read_input_tokens);
    expect(sum("outputTokens")).toBe(usage.output_tokens);
    expect(rows.every((row) => row.eventId !== null)).toBe(true);
  });

  it("shows Assistant unavailable when Anthropic refuses for its spend limit, and charges nothing", async () => {
    const [ann, ben] = s.members;
    const chatId = await openChat(ann!.id);
    fakeDriverControls.providerRefusal = "call";

    const res = await send(ann!.id, chatId, "Hello there");

    expect(res.status).toBe(503);
    const body = (await res.json()) as { errors: { context: { code: string } }[] };
    expect(body.errors[0]!.context.code).toBe("ASSISTANT_UNAVAILABLE");
    expect(await ledger()).toEqual([]);
    expect((await detail(ann!.id, chatId)).messages).toEqual([]);
    // Every organization's members see it, not only the one that hit it.
    expect((await weeklyLimitFor(ben!.id)).providerUnavailable).toBe(true);
    expect((await weeklyLimitFor(ben!.id)).weeklyLimit.percent).toBe(0);
  });

  it("charges nothing for a step Anthropic refused mid-session for its spend limit", async () => {
    const [ann] = s.members;
    const chatId = await openChat(ann!.id);
    fakeDriverControls.providerRefusal = "session";

    const res = await send(ann!.id, chatId, "Hello there");
    expect(res.status).toBe(200);
    const events = parseStream(await res.text());
    expect(events.filter((e) => e.event === "error").map((e) => e.data.code)).toEqual([
      "ASSISTANT_UNAVAILABLE",
    ]);
    await settleRelays();

    const rows = await mainSteps();
    expect(rows.map((row) => [row.status, row.settledMicroUsd])).toEqual([["settled", 0]]);
    const screens = (await ledger()).filter((row) => row.purpose === "screen");
    expect(await usedInLedger()).toBe(screens.reduce((sum, row) => sum + row.settledMicroUsd!, 0));
    const after = await detail(ann!.id, chatId);
    expect(after.messages.map((m) => [m.kind, m.code])).toEqual([
      ["user", null],
      ["notice", "ASSISTANT_UNAVAILABLE"],
    ]);
    expect((await weeklyLimitFor(ann!.id)).providerUnavailable).toBe(true);
  });

  it("meters the screen of every message as a settled screen step", async () => {
    const [ann] = s.members;
    const chatId = await openChat(ann!.id);

    const res = await send(ann!.id, chatId, "Hello there");
    expect(parseStream(await res.text()).at(-1)!.event).toBe("done");
    await settleRelays();

    const rows = await ledger();
    expect(rows.map((row) => [row.purpose, row.status])).toEqual([
      ["screen", "settled"],
      ["main", "settled"],
    ]);
    expect(rows[0]).toMatchObject({
      modelId: "claude-haiku-5-5",
      priceVersion: "claude-haiku-5-5@2026-11-01",
      chatId,
      cacheReadTokens: 2400,
      outputTokens: 12,
    });
    expect(rows[0]!.settledMicroUsd!).toBeGreaterThan(0);
    expect(rows[0]!.settledMicroUsd!).toBeLessThan(rows[0]!.reservedMicroUsd);
  });

  it("refuses a message whose screen fits but whose first step doesn't, keeping only the screen's cost", async () => {
    const [ann] = s.members;
    const chatId = await openChat(ann!.id);
    await seedUsage(TEN_DOLLARS - 10_000);

    const res = await send(ann!.id, chatId, "Hello there");

    expect(res.status).toBe(429);
    const rows = await ledger();
    expect(rows.map((row) => [row.purpose, row.status])).toEqual([
      ["main", "settled"],
      ["screen", "settled"],
    ]);
    expect(await usedInLedger()).toBeLessThanOrEqual(TEN_DOLLARS);
    expect((await detail(ann!.id, chatId)).messages).toEqual([]);
  });

  it("refuses an eleventh model call in one turn, once, whoever asks", async () => {
    const [ann] = s.members;
    const chatId = await openChat(ann!.id);
    const round = (modelCallsThisTurn: number, triggerEventId: string) =>
      reserveToolRound({
        organizationId: s.organizationId,
        userId: ann!.id,
        chatId,
        sessionId: "sesn_01Test",
        triggerEventId,
        appendedText: "{}",
        modelCallsThisTurn,
      });

    expect((await round(9, "sevt_01Ninth")).kind).toBe("reserved");
    expect(await round(9, "sevt_01Ninth")).toEqual({ kind: "joined" });
    expect(await round(10, "sevt_01Tenth")).toEqual({
      kind: "refused",
      code: "ASSISTANT_STEP_LIMIT",
    });
    // A second advance of the same idle finds the refusal, even with room to spare.
    expect(await round(0, "sevt_01Tenth")).toEqual({
      kind: "refused",
      code: "ASSISTANT_STEP_LIMIT",
    });
    expect(await ledger()).toHaveLength(1);
    expect((await detail(ann!.id, chatId)).messages.map((m) => [m.kind, m.code])).toEqual([
      ["notice", "ASSISTANT_STEP_LIMIT"],
    ]);
  });

  it("keeps the cost when the account is erased and drops the user link", async () => {
    const [ann] = s.members;
    await seedUsage(1_234, { userId: ann!.id });
    await db.execute(sql`delete from "user" where id = ${ann!.id}`);

    const [row] = await db
      .select()
      .from(assistantModelCalls)
      .where(and(eq(assistantModelCalls.organizationId, s.organizationId)));
    expect(row).toMatchObject({ userId: null, settledMicroUsd: 1_234 });
  });
});

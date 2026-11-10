import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { config } from "../../config.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { assistantModelCalls } from "../../db/schema/assistant-meter-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { notifications, notificationType } from "../../db/schema/notification-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { vacationEvents } from "../../db/schema/vacation-event-schema.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { fakeDriverControls } from "../../services/assistant/driver/fakeDriver.js";
import type { SessionEvent } from "../../services/assistant/driver/types.js";
import { clearProviderRefusal } from "../../services/assistant/meter/meter.js";
import { settleRelays } from "../../services/assistant/turnServices.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { apiAs } from "./helpers/directoryWorld.js";
import { addLeave, addMember, addQuota, makeGroup, makeUser } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

const sendTemplated = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../../services/email/index.js", () => ({ emailSender: { sendTemplated } }));

const ON = { assistantEnabled: true, aiConnectionsEnabled: false, previewOrganizationIds: [] };
const TEN_DOLLARS = 10_000_000;
const YEAR = new Date().getUTCFullYear() + 1;
/** A weekday of the first full week of June next year, Monday = 0. */
const juneWeekday = (offset: number) => {
  const first = new Date(Date.UTC(YEAR, 5, 1));
  const toMonday = (8 - first.getUTCDay()) % 7;
  return new Date(Date.UTC(YEAR, 5, 1 + toMonday + offset)).toISOString().slice(0, 10);
};
const MONDAY = juneWeekday(0);
const TUESDAY = juneWeekday(1);
const THURSDAY = juneWeekday(3);

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

type Card = {
  id: string;
  toolUseId: string;
  tool: string;
  status: "open" | "confirmed" | "declined" | "not_taken";
  preview: Record<string, unknown>;
  authorNames: string[];
  result: Record<string, unknown> | null;
  error: { message: string; code: string | null } | null;
};

type Message = {
  kind: string;
  toolName: string | null;
  toolOutcome: string | null;
  card: Card | null;
};

/**
 * Acme: Enterprise, the Assistant on. Olga owns it and manages Acme Team, so
 * she approves there. Ann and Bob book in Acme Team; Bob is no approver.
 */
const seed = async () => {
  const olga = await makeUser("Olga Owner");
  const team = await makeGroup("Acme Team", olga.id, { organizationOwnerId: olga.id });
  const [organization] = await db
    .update(organizations)
    .set({ name: "Acme", assistantEnabled: true })
    .where(eq(organizations.ownerUserId, olga.id))
    .returning({ id: organizations.id });
  const organizationId = organization!.id;
  await upsertSubscription(organizationId, {
    plan: subscriptionPlan.Enterprise,
    status: subscriptionStatus.Active,
    graceEndsAt: null,
  });
  const ann = await makeUser("Ann Member");
  const bob = await makeUser("Bob Member");
  await addMember(team, ann.id, { viewAccess: true });
  await addMember(team, bob.id, { viewAccess: true });
  for (const person of [olga, ann, bob]) await syncEmployment(organizationId, person.id);
  await addQuota(team, ann.id, YEAR, { vacationDays: 10 });
  await addQuota(team, bob.id, YEAR, { vacationDays: 10 });

  // Ann's two-day request, waiting on Olga, with a note of her own.
  const requestId = uuidv4();
  for (const day of [MONDAY, TUESDAY]) {
    await addLeave(team, ann.id, day, { requestId, approved: false, note: "Family trip" });
  }
  // One approved day already counts against her balance.
  await addLeave(team, ann.id, THURSDAY, { approvedBy: olga.id });
  return { organizationId, team, olga, ann, bob, requestId };
};

describe("Approve and reject cards", () => {
  let server: LoopbackServer;
  let s: Awaited<ReturnType<typeof seed>>;
  const savedSwitches = config.aiFeatures;
  const savedLimit = config.assistant.weeklyLimitMicroUsd;

  const resetData = async () => {
    await db.delete(vacationEvents);
    await db.delete(userYearQuotas);
    await cleanupTestData();
  };

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
    sendTemplated.mockClear();
    await resetData();
    s = await seed();
  });

  afterEach(async () => {
    fakeDriverControls.release?.();
    fakeDriverControls.reset();
    await settleRelays();
  });

  afterAll(async () => {
    config.aiFeatures = savedSwitches;
    config.assistant.weeklyLimitMicroUsd = savedLimit;
    await server?.close();
    await resetData();
  });

  const as = (userId: string) => apiAs(server.url, userId);

  const openChat = async (userId: string) => {
    const res = await (
      await as(userId)
    ).post("/api/assistant/chats", { organizationId: s.organizationId });
    expect(res.status).toBe(201);
    return (res.body as { chat: { id: string } }).chat.id;
  };

  const send = async (chatId: string, text: string, userId: string) => {
    const res = await fetch(`${server.url}/api/assistant/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: await authCookieFor(userId) },
      body: JSON.stringify({ text }),
    });
    expect(res.status).toBe(200);
    const events = parseStream(await res.text());
    await settleRelays();
    return events;
  };

  const follow = async (chatId: string, userId: string) => {
    const res = await fetch(`${server.url}/api/assistant/chats/${chatId}/stream`, {
      headers: { Cookie: await authCookieFor(userId) },
    });
    expect(res.status).toBe(200);
    const events = parseStream(await res.text());
    await settleRelays();
    return events;
  };

  const decide = async (
    cardId: string,
    decision: "confirm" | "decline",
    userId: string,
    body: object = {}
  ) => {
    const res = await (
      await as(userId)
    ).post(`/api/assistant/pending-actions/${cardId}/${decision}`, body);
    return res as unknown as {
      status: number;
      body: { card: Card; turnRunning: boolean; errors?: { context: { code?: string } }[] };
    };
  };

  const messagesOf = async (chatId: string, userId: string) => {
    const res = await (await as(userId)).get(`/api/assistant/chats/${chatId}`);
    expect(res.status).toBe(200);
    return (res.body as { messages: Message[] }).messages;
  };

  const cardsIn = async (chatId: string, userId: string) =>
    (await messagesOf(chatId, userId)).flatMap((m) => (m.card ? [m.card] : []));

  const toolResults = async (chatId: string) => {
    const [row] = await db
      .select({ sessionId: assistantModelCalls.sessionId })
      .from(assistantModelCalls)
      .where(and(eq(assistantModelCalls.chatId, chatId), eq(assistantModelCalls.purpose, "main")))
      .limit(1);
    return fakeDriverControls
      .events(row!.sessionId!)
      .filter(
        (e): e is Extract<SessionEvent, { type: "user.custom_tool_result" }> =>
          e.type === "user.custom_tool_result"
      )
      .map((e) => ({
        isError: e.is_error ?? false,
        body: JSON.parse(e.content.map((c) => c.text).join("")) as Record<string, unknown>,
      }));
  };

  const requestRows = () =>
    db
      .select()
      .from(vacation)
      .where(eq(vacation.requestId, s.requestId))
      .orderBy(vacation.requestedDay);

  const eventsOfRequest = async () => {
    const ids = (await requestRows()).map((row) => row.id);
    return db
      .select({ eventType: vacationEvents.eventType, channel: vacationEvents.channel })
      .from(vacationEvents)
      .where(inArray(vacationEvents.vacationId, ids));
  };

  const decisionNotices = () =>
    db
      .select({ userId: notifications.userId, title: notifications.title })
      .from(notifications)
      .where(eq(notifications.type, notificationType.ApprovalDecided));

  /** Olga asks what waits on her, then the model proposes the decision. */
  const propose = async (tool: "approve_request" | "reject_request", input: object = {}) => {
    const chatId = await openChat(s.olga.id);
    fakeDriverControls.steps.push(
      [{ tool: "list_requests_to_approve", input: {} }],
      [{ tool, input: { requestId: s.requestId, ...input } }]
    );
    await send(chatId, "What's waiting for my approval?", s.olga.id);
    const [card] = await cardsIn(chatId, s.olga.id);
    return { chatId, card: card! };
  };

  it("lists what waits on the approver, and approves only once the card is confirmed", async () => {
    const { chatId, card } = await propose("approve_request");

    const [listed] = await toolResults(chatId);
    expect(listed!.body).toMatchObject({
      requests: [
        {
          requestId: s.requestId,
          requester: { id: s.ann.id, name: { user_text: "Ann Member" } },
          group: { id: s.team, name: { user_text: "Acme Team" } },
          type: "VACATION",
          firstDay: MONDAY,
          lastDay: TUESDAY,
          days: 2,
          note: { user_text: "Family trip" },
          noteAuthor: { user_text: "Ann Member" },
        },
      ],
    });

    expect(card).toMatchObject({
      tool: "approve_request",
      status: "open",
      authorNames: ["Ann Member"],
      preview: {
        action: "approve_request",
        requestId: s.requestId,
        requester: { id: s.ann.id, name: "Ann Member" },
        group: { id: s.team, name: "Acme Team" },
        type: "VACATION",
        firstDay: MONDAY,
        lastDay: TUESDAY,
        days: 2,
        note: "Family trip",
        noteAuthor: "Ann Member",
        balances: [{ year: YEAR, type: "VACATION", remainingBefore: 9, remainingAfter: 7 }],
      },
    });
    // Nothing decided before the confirm.
    expect((await requestRows()).every((row) => row.approvedAt === null)).toBe(true);
    expect(await decisionNotices()).toEqual([]);

    const confirmed = await decide(card.id, "confirm", s.olga.id);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.card).toMatchObject({
      status: "confirmed",
      error: null,
      result: { status: "approved", firstDay: MONDAY, lastDay: TUESDAY, days: 2 },
    });
    await follow(chatId, s.olga.id);

    const rows = await requestRows();
    expect(rows.map((row) => [row.requestedDay, row.approvedBy])).toEqual([
      [MONDAY, s.olga.id],
      [TUESDAY, s.olga.id],
    ]);
    expect(await eventsOfRequest()).toEqual([
      { eventType: "APPROVED", channel: "assistant" },
      { eventType: "APPROVED", channel: "assistant" },
    ]);
    expect(await decisionNotices()).toEqual([{ userId: s.ann.id, title: "Time off approved" }]);
    expect(sendTemplated).toHaveBeenCalledWith(
      expect.objectContaining({ template: "vacation-approved" })
    );
    const results = await toolResults(chatId);
    expect(results.at(-1)).toMatchObject({ isError: false, body: { status: "approved" } });
  });

  it("rejects with the reason the approver typed on the card, and tells the requester", async () => {
    const { chatId, card } = await propose("reject_request", { reason: "Too short notice" });
    expect(card.preview).toMatchObject({ action: "reject_request", reason: "Too short notice" });

    const confirmed = await decide(card.id, "confirm", s.olga.id, {
      reason: "  The team is short that week  ",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.card).toMatchObject({
      status: "confirmed",
      result: { status: "rejected", reasonGiven: true },
    });
    await follow(chatId, s.olga.id);

    const rows = await requestRows();
    expect(rows.map((row) => [row.rejectedBy, row.rejectionReason])).toEqual([
      [s.olga.id, "The team is short that week"],
      [s.olga.id, "The team is short that week"],
    ]);
    expect(await eventsOfRequest()).toEqual([
      { eventType: "REJECTED", channel: "assistant" },
      { eventType: "REJECTED", channel: "assistant" },
    ]);
    expect(await decisionNotices()).toEqual([{ userId: s.ann.id, title: "Time off declined" }]);
    expect(sendTemplated).toHaveBeenCalledWith(
      expect.objectContaining({
        template: "vacation-rejected",
        data: expect.objectContaining({ reason: "The team is short that week" }),
      })
    );
    // The typed reason never reached the session: it skipped the screen.
    const last = (await toolResults(chatId)).at(-1)!;
    expect(last.body).toMatchObject({ status: "rejected", reasonGiven: true });
    expect(JSON.stringify(last.body)).not.toContain("short that week");
  });

  it("refuses a reason on any card but a reject", async () => {
    const { card } = await propose("approve_request");
    const res = await decide(card.id, "confirm", s.olga.id, { reason: "Enjoy" });
    expect(res.status).toBe(422);
    expect((await requestRows()).every((row) => row.approvedAt === null)).toBe(true);
  });

  it("gives a non-approver no card: the guard refuses the preview", async () => {
    const chatId = await openChat(s.bob.id);
    fakeDriverControls.steps.push([{ tool: "approve_request", input: { requestId: s.requestId } }]);
    await send(chatId, "Approve Ann's trip", s.bob.id);

    expect(await cardsIn(chatId, s.bob.id)).toEqual([]);
    const [refused] = await toolResults(chatId);
    expect(refused).toMatchObject({
      isError: true,
      body: { error: { message: "You are not allowed to approve one or more of these requests" } },
    });
    expect((await requestRows()).every((row) => row.approvedAt === null)).toBe(true);
  });

  it("keeps the card open in red when the guard refuses the confirm", async () => {
    const { card } = await propose("approve_request");
    // Olga stops managing the group before she confirms.
    await db.update(groups).set({ managerUserId: s.ann.id }).where(eq(groups.id, s.team));

    const res = await decide(card.id, "confirm", s.olga.id);
    expect(res.status).toBe(200);
    expect(res.body.card).toMatchObject({
      status: "open",
      error: { message: "You are not allowed to approve one or more of these requests" },
    });
    expect((await requestRows()).every((row) => row.approvedAt === null)).toBe(true);
    expect(await decisionNotices()).toEqual([]);
  });

  it("shows no author marker when nothing someone else wrote was read in the turn", async () => {
    const chatId = await openChat(s.olga.id);
    fakeDriverControls.steps.push([{ tool: "approve_request", input: { requestId: s.requestId } }]);
    await send(chatId, "Approve Ann's trip", s.olga.id);
    const [card] = await cardsIn(chatId, s.olga.id);
    // The note is still on the card, with whose words it is.
    expect(card).toMatchObject({
      authorNames: [],
      preview: { note: "Family trip", noteAuthor: "Ann Member" },
    });
  });

  it("names whoever booked on the requester's behalf as the note's author", async () => {
    await db
      .update(vacation)
      .set({ createdByUserId: s.bob.id, note: "Booked for Ann" })
      .where(eq(vacation.requestId, s.requestId));
    const { card } = await propose("reject_request");
    expect(card).toMatchObject({
      authorNames: ["Bob Member"],
      preview: { note: "Booked for Ann", noteAuthor: "Bob Member", reason: null },
    });
  });
});

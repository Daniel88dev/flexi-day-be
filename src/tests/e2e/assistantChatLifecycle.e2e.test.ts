import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { config } from "../../config.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import {
  assistantChatMessages,
  assistantChats,
  assistantHeldAnswers,
  assistantPendingActions,
  assistantRejectedTurns,
  assistantSessionDeletions,
} from "../../db/schema/assistant-schema.js";
import { attendanceSessions } from "../../db/schema/attendance-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import {
  ATTENDANCE_SETTINGS_DEFAULTS,
  type balanceMode,
} from "../../db/schema/organization-attendance-settings-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { runAssistantChatRetention } from "../../jobs/assistantChatRetentionJob.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { upsertAttendanceSettings } from "../../services/organization/attendanceSettingsServices.js";
import { fakeDriverControls } from "../../services/assistant/driver/fakeDriver.js";
import { clearProviderRefusal } from "../../services/assistant/meter/meter.js";
import { settleRelays } from "../../services/assistant/turnServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import {
  WEB_TEST_PASSWORD,
  authCookieFor,
  createWebUser,
  webSessionCookieFor,
} from "./helpers/authHelper.js";
import { apiAs } from "./helpers/directoryWorld.js";
import { addMember, makeGroup, makeUser, resetReportData } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

const ON = { assistantEnabled: true, aiConnectionsEnabled: false, previewOrganizationIds: [] };
const TEN_DOLLARS = 10_000_000;
const DAY_MS = 86_400_000;
const CLOSED = "ASSISTANT_CHAT_CLOSED";

const daysAgo = (days: number, from = new Date()) => new Date(from.getTime() - days * DAY_MS);

type ErrorBody = { errors?: { context?: { code?: string; reason?: string } }[] };

const makeOrganization = async (
  name: string,
  owner: { id: string },
  options: { attendance?: boolean } = {}
) => {
  const groupId = await makeGroup(`${name} Team`, owner.id, { organizationOwnerId: owner.id });
  const [organization] = await db
    .update(organizations)
    .set({ name, assistantEnabled: true })
    .where(eq(organizations.ownerUserId, owner.id))
    .returning({ id: organizations.id });
  const organizationId = organization!.id;
  await upsertSubscription(organizationId, {
    plan: subscriptionPlan.Enterprise,
    status: subscriptionStatus.Active,
    graceEndsAt: null,
  });
  if (options.attendance) {
    await upsertAttendanceSettings(organizationId, {
      ...ATTENDANCE_SETTINGS_DEFAULTS,
      balanceMode: ATTENDANCE_SETTINGS_DEFAULTS.balanceMode as balanceMode,
      attendanceEnabled: true,
      timezone: "Europe/Prague",
    });
  }
  await syncEmployment(organizationId, owner.id);
  return { organizationId, groupId };
};

const join = async (organization: { organizationId: string; groupId: string }, userId: string) => {
  await addMember(organization.groupId, userId, { viewAccess: true });
  await syncEmployment(organization.organizationId, userId);
};

/**
 * Acme (Enterprise, Assistant and attendance on) is Olga's; Jana and Ben are
 * members. Jana also belongs to Beta, Gus's organization, where nobody else is.
 */
const seed = async () => {
  const olga = await makeUser("Olga Owner");
  const jana = await createWebUser("Jana Member");
  const ben = await makeUser("Ben Member");
  const gus = await createWebUser("Gus Owner");
  const acme = await makeOrganization("Acme", olga, { attendance: true });
  const beta = await makeOrganization("Beta", gus);
  await join(acme, jana.id);
  await join(acme, ben.id);
  await join(beta, jana.id);
  return { olga, jana, ben, gus, acme, beta };
};

describe("Chat lifecycle and deletion", () => {
  let server: LoopbackServer;
  let s: Awaited<ReturnType<typeof seed>>;
  const savedSwitches = config.aiFeatures;
  const savedLimit = config.assistant.weeklyLimitMicroUsd;
  const savedCeiling = config.assistant.chatTokenCeiling;

  const clearChats = async () => {
    await db.delete(assistantChats);
    await db.delete(assistantRejectedTurns);
    await db.delete(assistantSessionDeletions);
    await db.delete(attendanceSessions);
  };

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    config.aiFeatures = { ...ON };
    config.assistant.weeklyLimitMicroUsd = TEN_DOLLARS;
    config.assistant.chatTokenCeiling = savedCeiling;
    fakeDriverControls.reset();
    fakeDriverControls.chunkDelayMs = 0;
    fakeDriverControls.stepDelayMs = 5;
    clearProviderRefusal();
    await clearChats();
    await resetReportData();
    await cleanupTestData();
    s = await seed();
  });

  afterEach(async () => {
    fakeDriverControls.release?.();
    await settleRelays();
    fakeDriverControls.reset();
  });

  afterAll(async () => {
    config.aiFeatures = savedSwitches;
    config.assistant.weeklyLimitMicroUsd = savedLimit;
    config.assistant.chatTokenCeiling = savedCeiling;
    await server?.close();
    await clearChats();
    await resetReportData();
    await cleanupTestData();
  });

  const as = (userId: string) => apiAs(server.url, userId);

  const openChat = async (userId: string, organizationId: string) => {
    const res = await (await as(userId)).post("/api/assistant/chats", { organizationId });
    expect(res.status).toBe(201);
    return (res.body as { chat: { id: string } }).chat.id;
  };

  const send = async (userId: string, chatId: string, text: string) => {
    const res = await fetch(`${server.url}/api/assistant/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: await authCookieFor(userId) },
      body: JSON.stringify({ text }),
    });
    const body = await res.text();
    await settleRelays();
    return { status: res.status, body };
  };

  const chatRow = async (chatId: string) => {
    const [row] = await db.select().from(assistantChats).where(eq(assistantChats.id, chatId));
    return row;
  };

  /** A chat with one answered message, so it has a session. */
  const chatWithSession = async (userId: string, organizationId: string) => {
    const chatId = await openChat(userId, organizationId);
    expect((await send(userId, chatId, "Hello")).status).toBe(200);
    const sessionId = (await chatRow(chatId))!.sessionId!;
    expect(sessionId).toBeTruthy();
    return { chatId, sessionId };
  };

  /** A chat in Acme whose last answer is an open clock-in card. */
  const chatWithCard = async (userId: string) => {
    const chat = await chatWithSession(userId, s.acme.organizationId);
    fakeDriverControls.steps.push([{ tool: "clock_in", input: {} }]);
    expect((await send(userId, chat.chatId, "Clock me in")).status).toBe(200);
    const [card] = await db
      .select()
      .from(assistantPendingActions)
      .where(eq(assistantPendingActions.chatId, chat.chatId));
    expect(card).toMatchObject({ status: "open", toolName: "clock_in" });
    return { ...chat, cardId: card!.id };
  };

  const detail = async (userId: string, chatId: string) => {
    const res = await (await as(userId)).get(`/api/assistant/chats/${chatId}`);
    return res as unknown as {
      status: number;
      body: {
        chat: { closed: "length" | "idle" | null };
        messages: { kind: string; code: string | null; card: { status: string } | null }[];
      };
    };
  };

  const decide = async (userId: string, cardId: string, decision: "confirm" | "decline") =>
    (await as(userId)).post(`/api/assistant/pending-actions/${cardId}/${decision}`, {});

  const chatsOf = (userId: string, organizationId?: string) =>
    db
      .select()
      .from(assistantChats)
      .where(
        organizationId
          ? and(
              eq(assistantChats.userId, userId),
              eq(assistantChats.organizationId, organizationId)
            )
          : eq(assistantChats.userId, userId)
      );

  const pendingActionsOf = (userId: string) =>
    db.select().from(assistantPendingActions).where(eq(assistantPendingActions.userId, userId));

  const outbox = () => db.select().from(assistantSessionDeletions);

  const expectSessionsDeleted = async (sessionIds: string[]) => {
    await vi.waitFor(() =>
      expect(fakeDriverControls.deletedSessions).toEqual(expect.arrayContaining(sessionIds))
    );
    await vi.waitFor(async () => expect(await outbox()).toEqual([]));
  };

  const setLastMessage = async (chatId: string, at: Date) => {
    await db.update(assistantChats).set({ lastMessageAt: at }).where(eq(assistantChats.id, chatId));
  };

  describe("closed chats", () => {
    it("closes a chat at the length ceiling: readable, refusing the next message", async () => {
      config.assistant.chatTokenCeiling = 1_000;
      const { chatId } = await chatWithSession(s.jana.id, s.acme.organizationId);

      const read = await detail(s.jana.id, chatId);
      expect(read.status).toBe(200);
      expect(read.body.chat.closed).toBe("length");
      const before = read.body.messages.length;

      const res = await send(s.jana.id, chatId, "One more thing");
      expect(res.status).toBe(409);
      const error = (JSON.parse(res.body) as ErrorBody).errors?.[0]?.context;
      expect(error).toMatchObject({ code: CLOSED, reason: "length" });
      expect((await detail(s.jana.id, chatId)).body.messages).toHaveLength(before);
      expect((await chatRow(chatId))!.turnStatus).toBe("idle");
    });

    it("stays open below the ceiling", async () => {
      const { chatId } = await chatWithSession(s.jana.id, s.acme.organizationId);
      expect((await detail(s.jana.id, chatId)).body.chat.closed).toBeNull();
      expect((await send(s.jana.id, chatId, "And another")).status).toBe(200);
    });

    it("lets the user decide the cards of the turn that reached the ceiling", async () => {
      const { chatId, cardId } = await chatWithCard(s.jana.id);
      config.assistant.chatTokenCeiling = 1_000;
      await db
        .update(assistantChats)
        .set({ contextTokens: 5_000 })
        .where(eq(assistantChats.id, chatId));
      expect((await detail(s.jana.id, chatId)).body.chat.closed).toBe("length");

      const res = await decide(s.jana.id, cardId, "decline");
      expect(res.status).toBe(200);
      await settleRelays();
    });

    it("closes a chat 30 days after its last message", async () => {
      const { chatId, cardId } = await chatWithCard(s.jana.id);
      await setLastMessage(chatId, daysAgo(29));
      expect((await detail(s.jana.id, chatId)).body.chat.closed).toBeNull();

      await setLastMessage(chatId, daysAgo(30.1));
      const read = await detail(s.jana.id, chatId);
      expect(read.status).toBe(200);
      expect(read.body.chat.closed).toBe("idle");

      const res = await send(s.jana.id, chatId, "Are you there?");
      expect(res.status).toBe(409);
      expect((JSON.parse(res.body) as ErrorBody).errors?.[0]?.context).toMatchObject({
        code: CLOSED,
        reason: "idle",
      });

      const decision = await decide(s.jana.id, cardId, "confirm");
      expect(decision.status).toBe(409);
      expect((decision.body as ErrorBody).errors?.[0]?.context).toMatchObject({
        code: CLOSED,
        reason: "idle",
      });
    });

    it("keeps chats readable on plan lapse and with the Assistant off, refusing new messages", async () => {
      const { chatId } = await chatWithSession(s.jana.id, s.acme.organizationId);

      await db
        .update(organizations)
        .set({ assistantEnabled: false })
        .where(eq(organizations.id, s.acme.organizationId));
      expect((await detail(s.jana.id, chatId)).status).toBe(200);
      let res = await send(s.jana.id, chatId, "Still there?");
      expect(res.status).toBe(403);
      expect((JSON.parse(res.body) as ErrorBody).errors?.[0]?.context).toMatchObject({
        reason: "TURNED_OFF",
      });

      await db
        .update(organizations)
        .set({ assistantEnabled: true })
        .where(eq(organizations.id, s.acme.organizationId));
      await upsertSubscription(s.acme.organizationId, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });
      expect((await detail(s.jana.id, chatId)).status).toBe(200);
      res = await send(s.jana.id, chatId, "Still there?");
      expect(res.status).toBe(403);
      expect((JSON.parse(res.body) as ErrorBody).errors?.[0]?.context).toMatchObject({
        reason: "PLAN",
      });

      const orgs = await (await as(s.jana.id)).get("/api/assistant/organizations");
      const acme = (
        orgs.body as { organizations: { organizationId: string; hasChats: boolean }[] }
      ).organizations.find((o) => o.organizationId === s.acme.organizationId);
      expect(acme).toMatchObject({ hasChats: true });
    });
  });

  describe("the nightly tick", () => {
    it("deletes the session on day 30 and keeps the display record, cards not taken", async () => {
      const old = await chatWithCard(s.jana.id);
      const recent = await chatWithSession(s.ben.id, s.acme.organizationId);
      const now = new Date();
      await setLastMessage(old.chatId, daysAgo(30.01, now));
      await setLastMessage(recent.chatId, daysAgo(29.9, now));

      await runAssistantChatRetention(now);

      expect(fakeDriverControls.deletedSessions).toEqual([old.sessionId]);
      expect(await outbox()).toEqual([]);
      expect((await chatRow(old.chatId))!.sessionId).toBeNull();
      expect((await chatRow(recent.chatId))!.sessionId).toBe(recent.sessionId);

      const read = await detail(s.jana.id, old.chatId);
      expect(read.status).toBe(200);
      expect(read.body.chat.closed).toBe("idle");
      expect(read.body.messages.find((m) => m.card)?.card?.status).toBe("not_taken");
      expect(
        await db
          .select()
          .from(assistantHeldAnswers)
          .where(eq(assistantHeldAnswers.chatId, old.chatId))
      ).toEqual([]);
    });

    it("deletes the display record, cards and rejected turns on day 180", async () => {
      const old = await chatWithCard(s.jana.id);
      const kept = await chatWithSession(s.ben.id, s.acme.organizationId);
      expect((await send(s.jana.id, old.chatId, "Give me a recipe for soup")).status).toBe(200);
      const rejected = await db
        .select()
        .from(assistantRejectedTurns)
        .where(eq(assistantRejectedTurns.chatId, old.chatId));
      expect(rejected).toHaveLength(1);

      const now = new Date();
      await setLastMessage(old.chatId, daysAgo(180.01, now));
      await setLastMessage(kept.chatId, daysAgo(179.9, now));

      await runAssistantChatRetention(now);

      expect(await chatRow(old.chatId)).toBeUndefined();
      expect(
        await db
          .select()
          .from(assistantChatMessages)
          .where(eq(assistantChatMessages.chatId, old.chatId))
      ).toEqual([]);
      expect(await pendingActionsOf(s.jana.id)).toEqual([]);
      expect(
        await db
          .select()
          .from(assistantRejectedTurns)
          .where(eq(assistantRejectedTurns.id, rejected[0]!.id))
      ).toEqual([]);
      expect(fakeDriverControls.deletedSessions).toContain(old.sessionId);
      expect(await chatRow(kept.chatId)).toBeDefined();
    });

    it("retries a session delete that failed on the next tick", async () => {
      const { chatId, sessionId } = await chatWithSession(s.jana.id, s.acme.organizationId);
      fakeDriverControls.sessionDeleteFailure = true;

      const res = await (await as(s.jana.id)).delete(`/api/assistant/chats/${chatId}`);
      expect(res.status).toBe(204);
      expect(await chatRow(chatId)).toBeUndefined();
      await vi.waitFor(async () =>
        expect(await outbox()).toEqual([expect.objectContaining({ sessionId, attempts: 1 })])
      );

      fakeDriverControls.sessionDeleteFailure = false;
      await runAssistantChatRetention();
      expect(fakeDriverControls.deletedSessions).toEqual([sessionId]);
      expect(await outbox()).toEqual([]);
    });
  });

  describe("leaving the organization", () => {
    const expectGoneInAcme = async (jana: {
      chatId: string;
      sessionId: string;
      cardId: string;
    }) => {
      expect(await chatsOf(s.jana.id, s.acme.organizationId)).toEqual([]);
      expect(await pendingActionsOf(s.jana.id)).toEqual([]);
      await expectSessionsDeleted([jana.sessionId]);
    };

    it("deletes a removed member's chats, sessions and open cards in that organization", async () => {
      const jana = await chatWithCard(s.jana.id);
      const elsewhere = await chatWithSession(s.jana.id, s.beta.organizationId);
      const ben = await chatWithSession(s.ben.id, s.acme.organizationId);

      const res = await (
        await as(s.olga.id)
      ).delete(`/api/group-user/${s.acme.groupId}/${s.jana.id}`);
      expect(res.status).toBe(200);

      await expectGoneInAcme(jana);
      expect((await decide(s.jana.id, jana.cardId, "confirm")).status).toBe(404);
      expect(await chatsOf(s.jana.id, s.beta.organizationId)).toHaveLength(1);
      expect(await chatsOf(s.ben.id)).toHaveLength(1);
      expect(fakeDriverControls.deletedSessions).not.toContain(elsewhere.sessionId);
      expect(fakeDriverControls.deletedSessions).not.toContain(ben.sessionId);
    });

    it("deletes them when the member leaves through End employment", async () => {
      const jana = await chatWithCard(s.jana.id);
      await chatWithSession(s.jana.id, s.beta.organizationId);
      const [employment] = await db
        .select()
        .from(employments)
        .where(
          and(
            eq(employments.organizationId, s.acme.organizationId),
            eq(employments.userId, s.jana.id)
          )
        );
      const today = new Date().toISOString().slice(0, 10);

      const res = await request(server.url)
        .post(`/api/employment/${employment!.id}/end`)
        .set("Cookie", await authCookieFor(s.olga.id))
        .send({ endedOn: today });
      expect(res.status).toBe(200);

      await expectGoneInAcme(jana);
      expect(await chatsOf(s.jana.id, s.beta.organizationId)).toHaveLength(1);
    });

    it("deletes every chat of a member who deletes their account, then Erase deletes any left", async () => {
      const jana = await chatWithCard(s.jana.id);
      const elsewhere = await chatWithSession(s.jana.id, s.beta.organizationId);

      const cookie = await webSessionCookieFor(server.url, s.jana.email);
      const res = await request(server.url)
        .post("/api/users/me/delete")
        .set("Cookie", cookie)
        .send({ password: WEB_TEST_PASSWORD });
      expect(res.status).toBe(204);

      expect(await chatsOf(s.jana.id)).toEqual([]);
      expect(await pendingActionsOf(s.jana.id)).toEqual([]);
      await expectSessionsDeleted([jana.sessionId, elsewhere.sessionId]);

      // A chat that predates this ticket's account deletion, still in the organization.
      const leftover = generateRandomUUID();
      await db.insert(assistantChats).values({
        id: leftover,
        organizationId: s.acme.organizationId,
        userId: s.jana.id,
        sessionId: "sesn_01LeftOverFromBefore",
      });
      const [employment] = await db
        .select()
        .from(employments)
        .where(
          and(
            eq(employments.organizationId, s.acme.organizationId),
            eq(employments.userId, s.jana.id)
          )
        );
      const erase = await request(server.url)
        .post(`/api/employment/${employment!.id}/erase`)
        .set("Cookie", await authCookieFor(s.olga.id))
        .send({ confirmName: "Jana Member" });
      expect(erase.status).toBe(204);

      expect(await chatRow(leftover)).toBeUndefined();
      await expectSessionsDeleted(["sesn_01LeftOverFromBefore"]);
    });
  });

  it("deletes every chat and session of an organization when it is deleted", async () => {
    const gus = await chatWithSession(s.gus.id, s.beta.organizationId);
    const jana = await chatWithSession(s.jana.id, s.beta.organizationId);
    const acme = await chatWithSession(s.jana.id, s.acme.organizationId);
    // Gus can delete his account once Beta has nobody else in it.
    const removed = await (
      await as(s.gus.id)
    ).delete(`/api/group-user/${s.beta.groupId}/${s.jana.id}`);
    expect(removed.status).toBe(200);
    await expectSessionsDeleted([jana.sessionId]);
    // A chat of someone else left in Beta: the organization's delete takes it too.
    const leftover = generateRandomUUID();
    await db.insert(assistantChats).values({
      id: leftover,
      organizationId: s.beta.organizationId,
      userId: s.ben.id,
      sessionId: "sesn_01OtherMemberInBeta",
    });

    const cookie = await webSessionCookieFor(server.url, s.gus.email);
    const res = await request(server.url)
      .post("/api/users/me/delete")
      .set("Cookie", cookie)
      .send({ password: WEB_TEST_PASSWORD });
    expect(res.status).toBe(204);

    expect(
      await db
        .select()
        .from(assistantChats)
        .where(eq(assistantChats.organizationId, s.beta.organizationId))
    ).toEqual([]);
    await expectSessionsDeleted([gus.sessionId, "sesn_01OtherMemberInBeta"]);
    expect(await chatRow(acme.chatId)).toBeDefined();
    expect(fakeDriverControls.deletedSessions).not.toContain(acme.sessionId);
  });
});

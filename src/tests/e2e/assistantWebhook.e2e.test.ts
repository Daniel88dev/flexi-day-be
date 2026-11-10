import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Webhook } from "standardwebhooks";
import { config } from "../../config.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { assistantChats } from "../../db/schema/assistant-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { logger } from "../../middleware/logger.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { fakeDriver, fakeDriverControls } from "../../services/assistant/driver/fakeDriver.js";
import type { SessionEvent } from "../../services/assistant/driver/types.js";
import { settleRelays } from "../../services/assistant/turnServices.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { apiAs } from "./helpers/directoryWorld.js";
import { addMember, addQuota, makeGroup, makeUser } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

const ON = { assistantEnabled: true, aiConnectionsEnabled: false, previewOrganizationIds: [] };
const OFF = { assistantEnabled: false, aiConnectionsEnabled: false, previewOrganizationIds: [] };
// A made-up Standard Webhooks secret: whsec_ plus base64 of 32 fixed bytes.
const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const year = new Date().getUTCFullYear();

type Message = {
  kind: string;
  text: string | null;
  toolName: string | null;
  toolOutcome: string | null;
};
type Detail = { chat: { turnRunning: boolean }; messages: Message[] };

const until = async (check: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const lastIdle = (sessionId: string) =>
  fakeDriverControls
    .events(sessionId)
    .findLast(
      (event): event is Extract<SessionEvent, { type: "session.status_idle" }> =>
        event.type === "session.status_idle"
    );

describe("Advancing a turn without its relay: the webhook and chat open", () => {
  let server: LoopbackServer;
  let jana: { id: string };
  let organizationId: string;
  const savedSwitches = config.aiFeatures;
  const savedAssistant = config.assistant;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    config.aiFeatures = { ...ON };
    config.assistant = { ...savedAssistant, driver: "fake", webhookSecret: SECRET };
    fakeDriverControls.reset();
    fakeDriverControls.chunkDelayMs = 0;
    fakeDriverControls.stepDelayMs = 5;
    await db.delete(userYearQuotas);
    await cleanupTestData();

    const owner = await makeUser("Acme Owner");
    const groupId = await makeGroup("Acme Team", owner.id, { organizationOwnerId: owner.id });
    const [organization] = await db
      .update(organizations)
      .set({ name: "Acme", assistantEnabled: true })
      .where(eq(organizations.ownerUserId, owner.id))
      .returning({ id: organizations.id });
    organizationId = organization!.id;
    await syncEmployment(organizationId, owner.id);
    await upsertSubscription(organizationId, {
      plan: subscriptionPlan.Enterprise,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });
    jana = await makeUser("Jana Member");
    await addMember(groupId, jana.id, { viewAccess: true });
    await syncEmployment(organizationId, jana.id);
    await addQuota(groupId, jana.id, year, { vacationDays: 20 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    fakeDriverControls.release?.();
    await settleRelays();
  });

  afterAll(async () => {
    config.aiFeatures = savedSwitches;
    config.assistant = savedAssistant;
    await server?.close();
    await db.delete(userYearQuotas);
    await cleanupTestData();
  });

  const as = (userId: string) => apiAs(server.url, userId);

  /**
   * A turn whose process died: the chat says a turn runs, the session waits
   * on a balance lookup, and no relay in this process follows it.
   */
  const strandedTurn = async (options: { idleAgoMs?: number } = {}) => {
    const created = await (await as(jana.id)).post("/api/assistant/chats", { organizationId });
    expect(created.status).toBe(201);
    const chatId = (created.body as { chat: { id: string } }).chat.id;
    const { sessionId } = await fakeDriver.createSession({
      chatId,
      organizationId,
      budgetMicroUsd: 1_000_000,
    });
    const [start] = await fakeDriver.sendEvents(sessionId, [
      { type: "user.message", content: [{ type: "text", text: "How many days do I have left?" }] },
      { type: "system.message", content: [{ type: "text", text: "App language: English." }] },
    ]);
    await until(() => lastIdle(sessionId)?.stop_reason.type === "requires_action", "the tool call");
    if (options.idleAgoMs) {
      lastIdle(sessionId)!.processed_at = new Date(Date.now() - options.idleAgoMs).toISOString();
    }
    await db
      .update(assistantChats)
      .set({
        sessionId,
        turnStatus: "running",
        turnStartedAt: new Date(),
        turnStartEventId: start!.id,
      })
      .where(eq(assistantChats.id, chatId));
    return { chatId, sessionId };
  };

  const detail = async (chatId: string) => {
    const res = await (await as(jana.id)).get(`/api/assistant/chats/${chatId}`);
    expect(res.status).toBe(200);
    return res.body as Detail;
  };

  const idled = (sessionId: string, eventId = `wevt_${generateRandomUUID()}`) => ({
    id: eventId,
    type: "event",
    created_at: new Date().toISOString(),
    data: {
      id: sessionId,
      type: "session.status_idled",
      organization_id: "org_fake",
      workspace_id: "wrkspc_fake",
    },
  });

  const deliver = (payload: object, options: { secret?: string; messageId?: string } = {}) => {
    const body = JSON.stringify(payload);
    const messageId = options.messageId ?? `msg_${generateRandomUUID()}`;
    const signature = new Webhook(options.secret ?? SECRET).sign(messageId, new Date(), body);
    return fetch(`${server.url}/api/webhooks/anthropic`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": messageId,
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-signature": signature,
      },
      body,
    });
  };

  describe("the session.status_idled webhook", () => {
    it("advances a chat whose tab is closed and whose relay is gone, to the end of the turn", async () => {
      const { chatId, sessionId } = await strandedTurn();

      const first = await deliver(idled(sessionId));
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ status: "advanced" });
      expect(
        (await detail(chatId)).messages.map((m) => [m.kind, m.toolName, m.toolOutcome])
      ).toEqual([["tool", "get_my_balances", "ok"]]);

      await until(() => lastIdle(sessionId)?.stop_reason.type === "end_turn", "the answer");
      const second = await deliver(idled(sessionId));
      expect(await second.json()).toEqual({ status: "advanced" });

      const after = await detail(chatId);
      expect(after.chat.turnRunning).toBe(false);
      expect(after.messages.map((m) => m.kind)).toEqual(["tool", "assistant"]);
      expect(after.messages[1]!.text).toContain("20 / 20");
    });

    it("ignores a duplicate delivery of an event it already handled", async () => {
      const { chatId, sessionId } = await strandedTurn();
      const payload = idled(sessionId);

      expect(await (await deliver(payload)).json()).toEqual({ status: "advanced" });
      const again = await deliver(payload);

      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ status: "duplicate" });
      expect((await detail(chatId)).messages.filter((m) => m.kind === "tool")).toHaveLength(1);
    });

    it("rejects a bad signature and leaves the chat alone", async () => {
      const { chatId, sessionId } = await strandedTurn();
      const warn = vi.spyOn(logger, "warn");
      const otherSecret = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;

      const forged = await deliver(idled(sessionId), { secret: otherSecret });
      const unsigned = await fetch(`${server.url}/api/webhooks/anthropic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(idled(sessionId)),
      });

      expect(forged.status).toBe(401);
      expect(unsigned.status).toBe(401);
      expect(warn).toHaveBeenCalledWith("assistant.webhook_rejected", expect.anything());
      expect((await detail(chatId)).messages).toEqual([]);
    });

    it("acknowledges events it has nothing to do with", async () => {
      const { chatId, sessionId } = await strandedTurn();

      const otherType = await deliver({
        ...idled(sessionId),
        data: { ...idled(sessionId).data, type: "session.running" },
      });
      const unknownSession = await deliver(idled("sesn_01Unknown"));

      expect(await otherType.json()).toEqual({ status: "ignored" });
      expect(await unknownSession.json()).toEqual({ status: "ignored" });
      expect((await detail(chatId)).messages).toEqual([]);
    });

    it("answers 404 while the Assistant is off or no webhook secret is set", async () => {
      const { sessionId } = await strandedTurn();

      config.aiFeatures = { ...OFF };
      expect((await deliver(idled(sessionId))).status).toBe(404);

      config.aiFeatures = { ...ON };
      config.assistant = { ...config.assistant, webhookSecret: undefined };
      expect((await deliver(idled(sessionId))).status).toBe(404);
    });
  });

  describe("opening a chat after a missed webhook", () => {
    it("advances the stranded turn, logs assistant.webhook_missed and follows it to the end", async () => {
      const { chatId } = await strandedTurn({ idleAgoMs: 60_000 });
      const warn = vi.spyOn(logger, "warn");

      const opened = await detail(chatId);

      expect(opened.messages.map((m) => [m.kind, m.toolName, m.toolOutcome])).toEqual([
        ["tool", "get_my_balances", "ok"],
      ]);
      expect(warn).toHaveBeenCalledWith("assistant.webhook_missed", { chatId });

      await settleRelays();
      const finished = await detail(chatId);
      expect(finished.chat.turnRunning).toBe(false);
      expect(finished.messages.map((m) => m.kind)).toEqual(["tool", "assistant"]);
    });

    it("does the same when the chat list opens", async () => {
      const { chatId } = await strandedTurn({ idleAgoMs: 60_000 });
      const warn = vi.spyOn(logger, "warn");

      const list = await (await as(jana.id)).get("/api/assistant/chats");
      expect(list.status).toBe(200);

      expect(warn).toHaveBeenCalledWith("assistant.webhook_missed", { chatId });
      await settleRelays();
      expect((await detail(chatId)).chat.turnRunning).toBe(false);
    });

    it("leaves a tool call alone while its webhook may still be on the way", async () => {
      const { chatId } = await strandedTurn();
      const warn = vi.spyOn(logger, "warn");

      const opened = await detail(chatId);

      expect(opened.messages).toEqual([]);
      expect(opened.chat.turnRunning).toBe(true);
      expect(warn).not.toHaveBeenCalledWith("assistant.webhook_missed", expect.anything());
    });
  });
});

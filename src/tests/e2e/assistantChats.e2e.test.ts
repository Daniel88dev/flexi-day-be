import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { organizationUsers } from "../../db/schema/organization-users-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { vacationEvents } from "../../db/schema/vacation-event-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { fakeDriverControls } from "../../services/assistant/driver/fakeDriver.js";
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

const makeOrganization = async (
  name: string,
  options: { plan: subscriptionPlan | null; assistantEnabled: boolean }
) => {
  const owner = await makeUser(`${name} Owner`);
  const groupId = await makeGroup(`${name} Team`, owner.id, { organizationOwnerId: owner.id });
  const [organization] = await db
    .update(organizations)
    .set({ name, assistantEnabled: options.assistantEnabled })
    .where(eq(organizations.ownerUserId, owner.id))
    .returning({ id: organizations.id });
  const organizationId = organization!.id;
  await syncEmployment(organizationId, owner.id);
  if (options.plan) {
    await upsertSubscription(organizationId, {
      plan: options.plan,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });
  }
  return { organizationId, groupId, owner };
};

const join = async (organization: { organizationId: string; groupId: string }, userId: string) => {
  await addMember(organization.groupId, userId, { viewAccess: true });
  await syncEmployment(organization.organizationId, userId);
};

/**
 * Jana belongs to Acme (Enterprise, Assistant on), Beta (Pro) and Gamma
 * (Enterprise, Assistant off). Olga administers Gamma. Otto belongs nowhere.
 */
const seed = async () => {
  const acme = await makeOrganization("Acme", {
    plan: subscriptionPlan.Enterprise,
    assistantEnabled: true,
  });
  const beta = await makeOrganization("Beta", {
    plan: subscriptionPlan.Pro,
    assistantEnabled: true,
  });
  const gamma = await makeOrganization("Gamma", {
    plan: subscriptionPlan.Enterprise,
    assistantEnabled: false,
  });
  const jana = await makeUser("Jana Member");
  const olga = await makeUser("Olga Admin");
  const otto = await makeUser("Otto Outsider");
  await join(acme, jana.id);
  await join(beta, jana.id);
  await join(gamma, jana.id);
  await join(gamma, olga.id);
  await db.insert(organizationUsers).values({
    id: generateRandomUUID(),
    organizationId: gamma.organizationId,
    userId: olga.id,
    grantedByUserId: gamma.owner.id,
  });
  await addQuota(acme.groupId, jana.id, year, { vacationDays: 20 });
  return { acme, beta, gamma, jana, olga, otto };
};

describe("The Assistant's chat API on the fake driver", () => {
  let server: LoopbackServer;
  let s: Awaited<ReturnType<typeof seed>>;
  const savedSwitches = config.aiFeatures;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    config.aiFeatures = { ...ON };
    fakeDriverControls.reset();
    fakeDriverControls.chunkDelayMs = 0;
    fakeDriverControls.stepDelayMs = 5;
    await db.delete(vacationEvents);
    await db.delete(userYearQuotas);
    await cleanupTestData();
    s = await seed();
  });

  afterEach(async () => {
    fakeDriverControls.release?.();
    await settleRelays();
  });

  afterAll(async () => {
    config.aiFeatures = savedSwitches;
    await server?.close();
    await db.delete(userYearQuotas);
    await cleanupTestData();
  });

  const as = (userId: string) => apiAs(server.url, userId);

  const openChat = async (userId: string, organizationId: string) => {
    const res = await (await as(userId)).post("/api/assistant/chats", { organizationId });
    expect(res.status).toBe(201);
    return (res.body as { chat: { id: string } }).chat.id;
  };

  /** A raw fetch, so the stream can be read as it arrives and dropped mid-turn. */
  const send = async (userId: string, chatId: string, text: string) =>
    fetch(`${server.url}/api/assistant/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: await authCookieFor(userId) },
      body: JSON.stringify({ text }),
    });

  it("answers a balance question through the read tool and keeps the display record", async () => {
    const chatId = await openChat(s.jana.id, s.acme.organizationId);

    const res = await send(s.jana.id, chatId, "How many vacation days do I have left?");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = parseStream(await res.text());

    const tools = events.filter((e) => e.event === "tool").map((e) => e.data);
    expect(tools).toEqual([
      expect.objectContaining({ name: "get_my_balances", status: "running" }),
      expect.objectContaining({ name: "get_my_balances", status: "done" }),
    ]);
    const deltas = events.filter((e) => e.event === "text" && e.id === null);
    expect(deltas.length).toBeGreaterThan(0);
    const [final] = events.filter((e) => e.event === "text" && e.id !== null);
    expect(final!.data.text).toContain("VACATION");
    expect(final!.data.text).toContain("20 / 20");
    expect(events.at(-1)!.event).toBe("done");

    const detail = await (await as(s.jana.id)).get(`/api/assistant/chats/${chatId}`);
    expect(detail.status).toBe(200);
    const body = detail.body as {
      chat: { title: string; turnRunning: boolean; organizationName: string };
      messages: {
        kind: string;
        text: string | null;
        toolName: string | null;
        toolOutcome: string | null;
      }[];
    };
    expect(body.chat).toMatchObject({
      title: "How many vacation days do I have left?",
      turnRunning: false,
      organizationName: "Acme",
    });
    expect(body.messages.map((m) => [m.kind, m.toolName, m.toolOutcome])).toEqual([
      ["user", null, null],
      ["tool", "get_my_balances", "ok"],
      ["assistant", null, null],
    ]);
    expect(body.messages[0]!.text).toBe("How many vacation days do I have left?");
    expect(body.messages[2]!.text).toBe(final!.data.text);

    const list = await (await as(s.jana.id)).get("/api/assistant/chats");
    expect((list.body as { chats: { id: string }[] }).chats.map((c) => c.id)).toEqual([chatId]);
  });

  /** Reads a stream until `until` holds for an event; answers everything parsed so far. */
  const readUntil = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    until: (event: StreamEvent) => boolean
  ): Promise<StreamEvent[]> => {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const complete = buffer.slice(0, buffer.lastIndexOf("\n\n") + 2);
      const events = parseStream(complete);
      if (events.some(until)) return events;
      const { value, done } = await reader.read();
      if (done) return parseStream(buffer);
      buffer += decoder.decode(value, { stream: true });
    }
  };

  it("replays a reconnect mid-turn without duplicates and refuses a second send with 409", async () => {
    const chatId = await openChat(s.jana.id, s.acme.organizationId);
    const otherChatId = await openChat(s.jana.id, s.acme.organizationId);
    const cookie = await authCookieFor(s.jana.id);
    const reconnect = (after?: string) =>
      fetch(`${server.url}/api/assistant/chats/${chatId}/stream${after ? `?after=${after}` : ""}`, {
        headers: { Cookie: cookie },
      });

    // The first model step is held: the turn runs, and the sender drops the connection.
    const releaseFirst = fakeDriverControls.hold();
    const first = await send(s.jana.id, chatId, "What's my balance?");
    expect(first.status).toBe(200);
    await first.body!.cancel();

    const conflict = await send(s.jana.id, otherChatId, "And who's away?");
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as {
      errors: { context: { code: string } }[];
    };
    expect(conflictBody.errors[0]!.context.code).toBe("ASSISTANT_TURN_RUNNING");
    expect((await send(s.jana.id, chatId, "Hello?")).status).toBe(409);
    const detail = await (await as(s.jana.id)).get(`/api/assistant/chats/${chatId}`);
    expect((detail.body as { chat: { turnRunning: boolean } }).chat.turnRunning).toBe(true);

    // Reconnect while held; let the tool call through and hold the answer.
    const firstReconnect = (await reconnect()).body!.getReader();
    releaseFirst();
    const releaseAnswer = fakeDriverControls.hold();
    const beforeDrop = await readUntil(
      firstReconnect,
      (e) => e.event === "tool" && e.data.status === "done"
    );
    await firstReconnect.cancel();
    const toolCall = beforeDrop.find((e) => e.event === "tool" && e.data.status === "running")!;
    expect(toolCall.data.name).toBe("get_my_balances");

    // Reconnect after the tool call: nothing seen is sent again.
    const secondReconnect = (await reconnect(toolCall.id!)).body!.getReader();
    releaseAnswer();
    const afterDrop = await readUntil(secondReconnect, (e) => e.event === "done");
    const ids = afterDrop.flatMap((e) => (e.id ? [e.id] : []));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(toolCall.id);
    expect(afterDrop.filter((e) => e.event === "tool" && e.data.status === "running")).toEqual([]);
    expect(afterDrop.filter((e) => e.event === "text" && e.id)).toHaveLength(1);
    expect(afterDrop.at(-1)!.event).toBe("done");

    await settleRelays();
    const record = await (await as(s.jana.id)).get(`/api/assistant/chats/${chatId}`);
    expect((record.body as { messages: { kind: string }[] }).messages.map((m) => m.kind)).toEqual([
      "user",
      "tool",
      "assistant",
    ]);
    const next = await send(s.jana.id, otherChatId, "Who's away?");
    expect(next.status).toBe(200);
    expect(parseStream(await next.text()).at(-1)!.event).toBe("done");
  });

  it("refuses a chat outside Enterprise, with the Assistant off, or without standing", async () => {
    const refusal = async (userId: string, organizationId: string) => {
      const res = await (await as(userId)).post("/api/assistant/chats", { organizationId });
      return [
        res.status,
        (res.body as { errors: { context: { reason?: string } }[] }).errors[0]!.context.reason,
      ];
    };
    expect(await refusal(s.jana.id, s.beta.organizationId)).toEqual([403, "PLAN"]);
    expect(await refusal(s.jana.id, s.gamma.organizationId)).toEqual([403, "TURNED_OFF"]);
    expect(await refusal(s.otto.id, s.acme.organizationId)).toEqual([403, "NO_STANDING"]);
  });

  it("stops new messages once the owner turns the Assistant off, and keeps the chat readable", async () => {
    const chatId = await openChat(s.jana.id, s.acme.organizationId);
    await db
      .update(organizations)
      .set({ assistantEnabled: false })
      .where(eq(organizations.id, s.acme.organizationId));

    const res = await send(s.jana.id, chatId, "Hello");
    expect(res.status).toBe(403);
    expect((await (await as(s.jana.id)).get(`/api/assistant/chats/${chatId}`)).status).toBe(200);
  });

  it("answers 404 everywhere while the switch is off, unless the organization is in preview", async () => {
    const chatId = await openChat(s.jana.id, s.acme.organizationId);
    config.aiFeatures = { ...ON, assistantEnabled: false };
    const api = await as(s.jana.id);
    expect((await api.get("/api/assistant/chats")).status).toBe(404);
    expect((await api.get(`/api/assistant/chats/${chatId}`)).status).toBe(404);
    expect(
      (await api.post("/api/assistant/chats", { organizationId: s.acme.organizationId })).status
    ).toBe(404);

    config.aiFeatures = {
      ...ON,
      assistantEnabled: false,
      previewOrganizationIds: [s.acme.organizationId],
    };
    expect((await api.get(`/api/assistant/chats/${chatId}`)).status).toBe(200);
    expect(
      (await api.post("/api/assistant/chats", { organizationId: s.beta.organizationId })).status
    ).toBe(404);
  });

  it("keeps each chat to its owner and deletes it with its session", async () => {
    const chatId = await openChat(s.jana.id, s.acme.organizationId);
    await (await send(s.jana.id, chatId, "Hi")).text();
    await settleRelays();

    expect((await (await as(s.olga.id)).get(`/api/assistant/chats/${chatId}`)).status).toBe(404);
    expect((await (await as(s.olga.id)).delete(`/api/assistant/chats/${chatId}`)).status).toBe(404);

    expect((await (await as(s.jana.id)).delete(`/api/assistant/chats/${chatId}`)).status).toBe(204);
    expect((await (await as(s.jana.id)).get(`/api/assistant/chats/${chatId}`)).status).toBe(404);
    expect(
      ((await (await as(s.jana.id)).get("/api/assistant/chats")).body as { chats: unknown[] }).chats
    ).toEqual([]);
  });

  it("lists the organizations with what the panel's button rules need", async () => {
    const answer = async (userId: string) =>
      (
        (await (await as(userId)).get("/api/assistant/organizations")).body as {
          organizations: Record<string, unknown>[];
        }
      ).organizations;

    expect(await answer(s.jana.id)).toEqual([
      expect.objectContaining({
        organizationName: "Acme",
        eligible: true,
        reason: null,
        planAllows: true,
        role: "member",
      }),
      expect.objectContaining({
        organizationName: "Beta",
        eligible: false,
        reason: "PLAN",
        planAllows: false,
        role: "member",
      }),
      expect.objectContaining({
        organizationName: "Gamma",
        eligible: false,
        reason: "TURNED_OFF",
        planAllows: true,
        role: "member",
      }),
    ]);
    expect(await answer(s.olga.id)).toEqual([
      expect.objectContaining({ organizationName: "Gamma", reason: "TURNED_OFF", role: "admin" }),
    ]);
    expect(await answer(s.beta.owner.id)).toEqual([
      expect.objectContaining({
        organizationName: "Beta",
        reason: "PLAN",
        planAllows: false,
        role: "owner",
      }),
    ]);
  });
});

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as Sentry from "@sentry/node";
import TransportStream from "winston-transport";
import { eq } from "drizzle-orm";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { config } from "../../config.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { logger } from "../../middleware/logger.js";
import { aiConnectionsLevel, organizations } from "../../db/schema/organization-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { userYearQuotas } from "../../db/schema/user-year-quotas-schema.js";
import { vacationEvents } from "../../db/schema/vacation-event-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { fakeDriverControls } from "../../services/assistant/driver/fakeDriver.js";
import { settleRelays } from "../../services/assistant/turnServices.js";
import { AI_SIGNALS } from "../../utils/aiSignals.js";
import { sentryPrivacyAndSampling } from "../../utils/sentryOptions.js";
import { authCookieFor, createWebUser } from "./helpers/authHelper.js";
import { connectAiApp, routePublicUrlTo } from "./helpers/aiConnectionGrant.js";
import { apiAs } from "./helpers/directoryWorld.js";
import { addLeave, addMember, addQuota, makeGroup } from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

const ON = { assistantEnabled: true, aiConnectionsEnabled: true, previewOrganizationIds: [] };

/** One marker per kind of content that must never leave the process. */
const CHAT = "chatmarker7f3a";
const NAME = "Namemarker4b9e";
const NOTE = "notemarker2c6d";
const ARGUMENT = "argmarker8e1f";
const CARD_NOTE = "cardmarker5a0b";
const MCP_NOTE = "mcpnotemarker3d7c";
const MARKERS = [CHAT, NAME, NOTE, ARGUMENT, CARD_NOTE, MCP_NOTE];

const today = new Date().toISOString().slice(0, 10);
const YEAR = new Date().getUTCFullYear() + 1;
/** A weekday of the first full week of June next year, Monday = 0. */
const juneWeekday = (offset: number) => {
  const first = new Date(Date.UTC(YEAR, 5, 1));
  const monday = 1 + ((8 - first.getUTCDay()) % 7);
  return new Date(Date.UTC(YEAR, 5, monday + offset)).toISOString().slice(0, 10);
};
const MONDAY = juneWeekday(0);
const TUESDAY = juneWeekday(1);

/** Everything Sentry would send (spans, logs, metrics, errors), as it would leave the process. */
const outbox: string[] = [];
/** Every winston entry, which the console and file transports write out. */
const written: string[] = [];

class Capture extends TransportStream {
  override log(info: unknown, done: () => void) {
    written.push(JSON.stringify(info));
    done();
  }
}

const seed = async () => {
  const olga = await createWebUser("Olga Owner");
  const jana = await createWebUser("Jana Member");
  const colleague = await createWebUser(`Quinn ${NAME}`);
  const team = await makeGroup("Acme Team", olga.id, { organizationOwnerId: olga.id });
  const [acme] = await db
    .update(organizations)
    .set({ name: "Acme", assistantEnabled: true, aiConnections: aiConnectionsLevel.Write })
    .where(eq(organizations.ownerUserId, olga.id))
    .returning({ id: organizations.id });
  const organizationId = acme!.id;
  await upsertSubscription(organizationId, {
    plan: subscriptionPlan.Enterprise,
    status: subscriptionStatus.Active,
    graceEndsAt: null,
  });
  await addMember(team, jana.id, { viewAccess: true });
  await addMember(team, colleague.id, { viewAccess: true });
  for (const person of [olga, jana, colleague]) await syncEmployment(organizationId, person.id);
  await addQuota(team, jana.id, new Date().getUTCFullYear(), { vacationDays: 20 });
  await addQuota(team, jana.id, YEAR, { vacationDays: 20 });
  await addLeave(team, colleague.id, today, { note: NOTE });
  await addLeave(team, jana.id, today, { note: NOTE });
  return { jana, organizationId };
};

describe("Assistant and /mcp telemetry carries no content", () => {
  let server: LoopbackServer;
  let restoreFetch: () => void;
  let s: Awaited<ReturnType<typeof seed>>;
  const capture = new Capture();
  let sentryLogs: TransportStream;
  const savedSwitches = config.aiFeatures;

  beforeAll(async () => {
    Sentry.init({
      dsn: "https://public@sentry.invalid/1",
      defaultIntegrations: false,
      ...sentryPrivacyAndSampling({
        SENTRY_TRACES_SAMPLE_RATE: "1",
        SENTRY_TRACES_MCP_RATE: "1",
        SENTRY_TRACES_ASSISTANT_RATE: "1",
      }),
      transport: () => ({
        send: (envelope) => {
          outbox.push(JSON.stringify(envelope));
          return Promise.resolve({});
        },
        flush: () => Promise.resolve(true),
      }),
    });
    sentryLogs = new (Sentry.createSentryWinstonTransport(TransportStream))();
    logger.add(sentryLogs);
    logger.add(capture);

    config.aiFeatures = { ...ON };
    fakeDriverControls.reset();
    fakeDriverControls.chunkDelayMs = 0;
    fakeDriverControls.stepDelayMs = 5;
    server = await listenOnLoopback(createServer());
    restoreFetch = routePublicUrlTo(server.url);
    await db.delete(vacationEvents);
    await db.delete(userYearQuotas);
    await cleanupTestData();
    s = await seed();
  });

  afterAll(async () => {
    logger.remove(capture);
    logger.remove(sentryLogs);
    await Sentry.close();
    fakeDriverControls.reset();
    config.aiFeatures = savedSwitches;
    restoreFetch();
    await server?.close();
    await db.delete(vacationEvents);
    await db.delete(userYearQuotas);
    await cleanupTestData();
  });

  const send = async (chatId: string, text: string) => {
    const res = await fetch(`${server.url}/api/assistant/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: await authCookieFor(s.jana.id) },
      body: JSON.stringify({ text }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    await settleRelays();
    return body;
  };

  it("keeps chat text, tool arguments and results, card previews and names out of spans and logs on both channels", async () => {
    const api = await apiAs(server.url, s.jana.id);
    const opened = await api.post("/api/assistant/chats", { organizationId: s.organizationId });
    expect(opened.status).toBe(201);
    const chatId = (opened.body as { chat: { id: string } }).chat.id;

    // Assistant: a read whose result names a colleague and a note, echoed in the answer.
    expect(await send(chatId, `Who is away this week? ${CHAT}`)).toContain(NAME);
    // Assistant: a read refused for its arguments, which the model wrote.
    fakeDriverControls.steps.push([
      { tool: "list_who_is_away", input: { from: ARGUMENT, to: ARGUMENT } },
    ]);
    await send(chatId, `Check that ${CHAT}`);
    // Assistant: a write, parked as a card whose preview carries the note, then confirmed.
    fakeDriverControls.steps.push([
      { tool: "create_request", input: { from: MONDAY, to: MONDAY, note: CARD_NOTE } },
    ]);
    await send(chatId, `Book it ${CHAT}`);
    const detail = await api.get(`/api/assistant/chats/${chatId}`);
    const card = (detail.body as { messages: { card: { id: string } | null }[] }).messages.find(
      (message) => message.card
    )?.card;
    expect(card).toBeDefined();
    const confirmed = await api.post(`/api/assistant/pending-actions/${card!.id}/confirm`, {});
    expect(confirmed.status).toBe(200);
    await settleRelays();

    // /mcp: a write with a note, then reads whose results carry notes and names.
    const { accessToken } = await connectAiApp({
      serverUrl: server.url,
      email: s.jana.email,
      organizationId: s.organizationId,
    });
    const client = new Client(
      { name: "e2e", version: "1.0.0" },
      { versionNegotiation: { mode: "legacy" } }
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
      })
    );
    try {
      const created = await client.callTool({
        name: "create_request",
        arguments: { from: TUESDAY, to: TUESDAY, note: MCP_NOTE },
      });
      expect(JSON.stringify(created)).toContain(MCP_NOTE);
      const mine = await client.callTool({
        name: "list_my_requests",
        arguments: { from: `${YEAR}-01-01`, to: `${YEAR}-12-31` },
      });
      expect(JSON.stringify(mine)).toContain(MCP_NOTE);
      const away = await client.callTool({
        name: "list_who_is_away",
        arguments: { from: today, to: today },
      });
      expect(JSON.stringify(away)).toContain(NAME);
      const refused = await client.callTool({
        name: "list_who_is_away",
        arguments: { from: ARGUMENT, to: ARGUMENT },
      });
      expect(refused.isError).toBe(true);
    } finally {
      await client.close();
    }

    await Sentry.flush(2000);
    const sent = outbox.join("\n");
    const logged = written.join("\n");

    // The telemetry is there: tool, relay and advance spans with the chat as the conversation,
    // the signals, and the request lines.
    expect(sent).toContain("gen_ai.execute_tool");
    expect(sent).toContain('"assistant.relay"');
    expect(sent).toContain('"assistant.advance"');
    expect(sent).toContain(`"gen_ai.conversation.id":{"value":"${chatId}"`);
    expect(sent).toContain('"assistant.cost_usd"');
    expect(sent).toContain('"type":"trace_metric"');
    expect(logged).toContain('"message":"assistant.cost_usd"');
    expect(logged).toContain(`/api/assistant/chats/${chatId}/messages 200`);
    expect(logged).toContain("POST /mcp 200");

    for (const marker of MARKERS) {
      expect(sent, `Sentry carries ${marker}`).not.toContain(marker);
      expect(logged, `the logs carry ${marker}`).not.toContain(marker);
    }
  });

  it("emits each AI signal with its allowed attributes only", () => {
    const allowed = new Set<string>(
      Object.values(AI_SIGNALS).flatMap((spec) => [...spec.attributes])
    );
    const entries = written
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => typeof entry.message === "string" && entry.message in AI_SIGNALS);
    expect(entries.map((entry) => entry.message)).toContain("assistant.cost_usd");
    for (const entry of entries) {
      const own = Object.keys(entry).filter(
        (key) =>
          !["level", "message", "timestamp"].includes(key) &&
          !key.includes(".") &&
          !key.startsWith("client")
      );
      expect(
        own.every((key) => allowed.has(key)),
        JSON.stringify(own)
      ).toBe(true);
    }
  });
});

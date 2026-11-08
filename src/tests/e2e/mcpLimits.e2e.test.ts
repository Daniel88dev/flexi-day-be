import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { config } from "../../config.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import {
  aiConnectionDailyCalls,
  aiConnectionMemberDailyCalls,
} from "../../db/schema/ai-connection-usage-schema.js";
import { aiConnectionsLevel, organizations } from "../../db/schema/organization-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { appLanguage, userSettings } from "../../db/schema/user-settings-schema.js";
import { logger } from "../../middleware/logger.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { addMember, makeGroup, resetReportData } from "./helpers/reportFixtures.js";
import { createWebUser } from "./helpers/authHelper.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { connectAiApp, routePublicUrlTo } from "./helpers/aiConnectionGrant.js";

const ON = { assistantEnabled: false, aiConnectionsEnabled: true, previewOrganizationIds: [] };

const resetData = async () => {
  await cleanupTestData();
  await resetReportData();
};

const nextUtcMidnight = () => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  ).toISOString();
};

/**
 * Acme (Pro, Read and write): Olga owns it, Jana is a member.
 * Beta (Enterprise, Read and write): Bob owns it, Jana is a member there too.
 */
const seed = async () => {
  const olga = await createWebUser("Olga Owner");
  const jana = await createWebUser("Jana Member");
  const bob = await createWebUser("Bob Beta");
  const world = async (owner: { id: string }, plan: subscriptionPlan) => {
    const group = await makeGroup("Team", owner.id, { organizationOwnerId: owner.id });
    const [organization] = await db
      .update(organizations)
      .set({ aiConnections: aiConnectionsLevel.Write })
      .where(eq(organizations.ownerUserId, owner.id))
      .returning({ id: organizations.id });
    await upsertSubscription(organization!.id, {
      plan,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });
    await addMember(group, jana.id);
    for (const person of [owner, jana]) await syncEmployment(organization!.id, person.id);
    return organization!.id;
  };
  return {
    acmeId: await world(olga, subscriptionPlan.Pro),
    betaId: await world(bob, subscriptionPlan.Enterprise),
    olga,
    jana,
  };
};

type Seeded = Awaited<ReturnType<typeof seed>>;

describe("/mcp limits", () => {
  let server: LoopbackServer;
  let restoreFetch: () => void;
  let s: Seeded;
  const savedSwitches = config.aiFeatures;

  beforeAll(async () => {
    config.aiFeatures = { ...ON };
    server = await listenOnLoopback(createServer());
    restoreFetch = routePublicUrlTo(server.url);
    await resetData();
    s = await seed();
  });

  afterAll(async () => {
    config.aiFeatures = savedSwitches;
    restoreFetch();
    await server?.close();
    await resetData();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(aiConnectionDailyCalls);
    await db.delete(aiConnectionMemberDailyCalls);
  });

  /** A fresh client registration, so the per-client burst budgets start empty. */
  const connect = async (email: string, organizationId: string) =>
    (await connectAiApp({ serverUrl: server.url, email, organizationId })).accessToken;

  const withClient = async <T>(bearer: string, use: (client: Client) => Promise<T>) => {
    const client = new Client(
      { name: "e2e", version: "1.0.0" },
      { versionNegotiation: { mode: "legacy" } }
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
      })
    );
    try {
      return await use(client);
    } finally {
      await client.close();
    }
  };

  type ToolResult = { isError?: boolean; content?: unknown };
  const errorOf = (result: ToolResult) => {
    expect(result.isError).toBe(true);
    const [first] = result.content as { type: string; text: string }[];
    return (
      JSON.parse(first!.text) as { error: { message: string; context: Record<string, unknown> } }
    ).error;
  };

  const counters = async (organizationId: string, userId: string) => {
    const [organization] = await db
      .select()
      .from(aiConnectionDailyCalls)
      .where(eq(aiConnectionDailyCalls.organizationId, organizationId));
    const [member] = await db
      .select()
      .from(aiConnectionMemberDailyCalls)
      .where(
        and(
          eq(aiConnectionMemberDailyCalls.organizationId, organizationId),
          eq(aiConnectionMemberDailyCalls.userId, userId)
        )
      );
    return { organization, member };
  };

  const seedOrganizationCalls = (organizationId: string, calls: number) =>
    db.insert(aiConnectionDailyCalls).values({ organizationId, calls });
  const seedMemberCalls = (organizationId: string, userId: string, calls: number) =>
    db.insert(aiConnectionMemberDailyCalls).values({ organizationId, userId, calls });

  const balances = { name: "get_my_balances", arguments: {} };

  describe("unauthenticated requests", () => {
    const post = (address: string, token?: string) =>
      fetch(`${server.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-Forwarded-For": address,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });

    it("answers 429 with Retry-After after 2,000 per address, and still serves a valid token", async () => {
      const token = await connect(s.jana.email, s.acmeId);
      const address = "203.0.113.70";

      const statuses: number[] = [];
      for (let i = 0; i < 2000; i++) statuses.push((await post(address)).status);
      expect(statuses.every((status) => status === 401)).toBe(true);

      const blocked = await post(address);
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await blocked.json()).toMatchObject({
        jsonrpc: "2.0",
        error: { message: "Too many requests" },
      });

      const badToken = await post(address, "not-a-token");
      expect(badToken.status).toBe(429);

      const valid = await withClient(token, (client) => client.listTools());
      expect(valid.tools.length).toBeGreaterThan(0);

      // Another address has its own budget.
      expect((await post("203.0.113.71")).status).toBe(401);
    });

    it("never counts a request whose token verifies", async () => {
      const token = await connect(s.jana.email, s.acmeId);
      const address = "203.0.113.72";
      for (let i = 0; i < 2005; i++) {
        const res = await post(address, token);
        if (res.status !== 200) throw new Error(`answered ${res.status.toString()}`);
      }
      expect((await post(address)).status).toBe(401);
    });
  });

  describe("burst limits per user and app", () => {
    it("refuses the 301st tool call in 5 minutes as an isError result naming the limit and reset", async () => {
      const token = await connect(s.jana.email, s.acmeId);
      const before = Date.now();

      const result = await withClient(token, async (client) => {
        for (let i = 0; i < 300; i++) {
          const ok = await client.callTool(balances);
          if (ok.isError) throw new Error(JSON.stringify(ok.content));
        }
        return client.callTool(balances);
      });

      const error = errorOf(result);
      expect(error.context.code).toBe("MCP_CALLS_PER_FIVE_MINUTES");
      expect(error.context.limit).toBe(300);
      const resetsAt = Date.parse(error.context.resetsAt as string);
      expect(resetsAt).toBeGreaterThan(before);
      expect(resetsAt).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);
      expect(error.message).toContain("300 tool calls in 5 minutes");
      expect(error.message).toContain(
        `${(error.context.resetsAt as string).slice(0, 16).replace("T", " ")} UTC`
      );

      // The refused call reached no daily counter.
      const { member } = await counters(s.acmeId, s.jana.id);
      expect(member?.calls).toBe(300);

      // Another app of the same person has a budget of its own.
      const other = await connect(s.jana.email, s.acmeId);
      const fresh = await withClient(other, (client) => client.callTool(balances));
      expect(fresh.isError).toBeFalsy();
    });

    it("refuses the 31st write-tool call in an hour, in the user's app language", async () => {
      const token = await connect(s.jana.email, s.acmeId);
      await db
        .insert(userSettings)
        .values({ userId: s.jana.id, language: appLanguage.Czech })
        .onConflictDoUpdate({ target: userSettings.userId, set: { language: appLanguage.Czech } });
      try {
        const cancel = { name: "cancel_my_request", arguments: { requestId: uuidv4() } };
        const [first, last, read] = await withClient(token, async (client) => {
          const answers: ToolResult[] = [];
          for (let i = 0; i < 30; i++) answers.push(await client.callTool(cancel));
          return [answers[0]!, await client.callTool(cancel), await client.callTool(balances)];
        });

        // The first 30 ran and were refused by the guard, not by a limit.
        expect(errorOf(first).message).not.toContain("limit");
        const error = errorOf(last);
        expect(error.context.code).toBe("MCP_WRITES_PER_HOUR");
        expect(error.context.limit).toBe(30);
        expect(error.message).toContain("limit je 30 změn za hodinu");
        expect(read.isError).toBeFalsy();
      } finally {
        await db.delete(userSettings).where(eq(userSettings.userId, s.jana.id));
      }
    });
  });

  describe("daily limits", () => {
    it("refuses a Pro organization's 5,001st call of the UTC day and logs it once", async () => {
      const token = await connect(s.jana.email, s.acmeId);
      await seedOrganizationCalls(s.acmeId, 4999);
      const info = vi.spyOn(logger, "info");

      const [last, refused, again] = await withClient(token, async (client) => [
        await client.callTool(balances),
        await client.callTool(balances),
        await client.callTool(balances),
      ]);

      expect(last.isError).toBeFalsy();
      const error = errorOf(refused);
      expect(error.context).toEqual({
        code: "DAILY_AI_CONNECTION_LIMIT",
        limit: 5000,
        resetsAt: nextUtcMidnight(),
      });
      expect(error.message).toBe(
        `This organization reached its daily AI connection limit of 5,000 calls. It resets at midnight UTC (${nextUtcMidnight().slice(0, 10)} 00:00 UTC).`
      );
      expect(errorOf(again).context.code).toBe("DAILY_AI_CONNECTION_LIMIT");

      const { organization, member } = await counters(s.acmeId, s.jana.id);
      expect(organization?.calls).toBe(5000);
      expect(organization?.limitReachedAt).toBeInstanceOf(Date);
      expect(member?.calls).toBe(1);
      const logged = info.mock.calls.filter(
        ([message]) => (message as unknown) === "mcp.daily_limit_reached"
      );
      expect(logged).toEqual([
        ["mcp.daily_limit_reached", { organizationId: s.acmeId, limit: 5000 }],
      ]);
    });

    it("gives Enterprise 20,000 calls a day", async () => {
      const token = await connect(s.jana.email, s.betaId);
      await seedOrganizationCalls(s.betaId, 19_999);

      const [last, refused] = await withClient(token, async (client) => [
        await client.callTool(balances),
        await client.callTool(balances),
      ]);

      expect(last.isError).toBeFalsy();
      expect(errorOf(refused).context).toMatchObject({
        code: "DAILY_AI_CONNECTION_LIMIT",
        limit: 20_000,
      });
    });

    it("refuses a member's 1,001st call in one organization and leaves the others", async () => {
      const token = await connect(s.jana.email, s.acmeId);
      const betaToken = await connect(s.jana.email, s.betaId);
      await seedMemberCalls(s.acmeId, s.jana.id, 999);

      const [last, refused] = await withClient(token, async (client) => [
        await client.callTool(balances),
        await client.callTool(balances),
      ]);

      expect(last.isError).toBeFalsy();
      const error = errorOf(refused);
      expect(error.context).toEqual({
        code: "MEMBER_DAILY_LIMIT",
        limit: 1000,
        resetsAt: nextUtcMidnight(),
      });
      expect(error.message).toContain("member daily limit of 1,000 calls");

      // The refused call is not on the organization's count either.
      const { organization, member } = await counters(s.acmeId, s.jana.id);
      expect(member?.calls).toBe(1000);
      expect(organization?.calls).toBe(1);
      expect(organization?.limitReachedAt).toBeNull();

      const beta = await withClient(betaToken, (client) => client.callTool(balances));
      expect(beta.isError).toBeFalsy();
    });

    it("counts only tools/call: not initialize, tools/list, resources or pings", async () => {
      const token = await connect(s.jana.email, s.acmeId);

      await withClient(token, async (client) => {
        await client.listTools();
        await client.listResources();
        await client.ping();
      });
      expect(await counters(s.acmeId, s.jana.id)).toEqual({
        organization: undefined,
        member: undefined,
      });

      await withClient(token, (client) => client.callTool(balances));
      const { organization, member } = await counters(s.acmeId, s.jana.id);
      expect(organization?.calls).toBe(1);
      expect(member?.calls).toBe(1);
      const { rows } = await db.execute<{ today: string }>(
        sql`SELECT (date_trunc('day', now() AT TIME ZONE 'UTC'))::date::text AS today`
      );
      expect(organization?.day).toBe(rows[0]?.today);
    });
  });
});

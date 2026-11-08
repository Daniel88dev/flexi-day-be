import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { config } from "../../config.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { oauthClient } from "../../db/schema/auth-schema.js";
import { aiConnectionsLevel, organizations } from "../../db/schema/organization-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { auth } from "../../utils/auth.js";
import { makeGroup, resetReportData } from "./helpers/reportFixtures.js";
import { createWebUser } from "./helpers/authHelper.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { connectAiApp, routePublicUrlTo } from "./helpers/aiConnectionGrant.js";

const ON = { assistantEnabled: false, aiConnectionsEnabled: true, previewOrganizationIds: [] };

const resetData = async () => {
  await cleanupTestData();
  await resetReportData();
};

/**
 * better-auth's limiter is off under vitest (`rateLimit.enabled`). It reads the
 * flag per request, so a test turns it on for itself alone.
 */
const withBetterAuthLimits = async (run: () => Promise<void>) => {
  const context = await auth.$context;
  const before = context.rateLimit.enabled;
  context.rateLimit.enabled = true;
  try {
    await run();
  } finally {
    context.rateLimit.enabled = before;
  }
};

describe("OAuth endpoint limits", () => {
  let server: LoopbackServer;
  let restoreFetch: () => void;
  const savedSwitches = config.aiFeatures;

  beforeAll(async () => {
    config.aiFeatures = { ...ON };
    server = await listenOnLoopback(createServer());
    restoreFetch = routePublicUrlTo(server.url);
    await resetData();
  });

  afterAll(async () => {
    config.aiFeatures = savedSwitches;
    restoreFetch();
    await server?.close();
    await resetData();
  });

  const register = () =>
    fetch(`${server.url}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Limit test app",
        redirect_uris: ["http://localhost:51234/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });

  const expectTooMany = async (res: Response, window: number) => {
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(window);
  };

  it("allows 5 registrations a minute from one address", async () => {
    await withBetterAuthLimits(async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await register()).status);
      expect(statuses).toEqual([201, 201, 201, 201, 201]);
      await expectTooMany(await register(), 60);
    });
  });

  it("allows 30 authorization requests a minute from one address", async () => {
    await withBetterAuthLimits(async () => {
      const authorize = () =>
        fetch(`${server.url}/api/auth/oauth2/authorize?client_id=unknown`, { redirect: "manual" });
      for (let i = 0; i < 30; i++) expect((await authorize()).status).not.toBe(429);
      await expectTooMany(await authorize(), 60);
    });
  });

  it("allows 600 token requests a minute from one address", async () => {
    await withBetterAuthLimits(async () => {
      const token = () =>
        fetch(`${server.url}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "grant_type=authorization_code&code=nope&client_id=unknown",
        });
      const statuses: number[] = [];
      for (let i = 0; i < 600; i++) statuses.push((await token()).status);
      expect(statuses.filter((status) => status === 429)).toEqual([]);
      await expectTooMany(await token(), 60);
    });
  });

  describe("pruning on registration", () => {
    const backdate = (clientIds: string[]) =>
      db
        .update(oauthClient)
        .set({ createdAt: sql`now() - interval '8 days'` })
        .where(inArray(oauthClient.clientId, clientIds));

    const remaining = async (clientIds: string[]) =>
      (
        await db
          .select({ clientId: oauthClient.clientId })
          .from(oauthClient)
          .where(inArray(oauthClient.clientId, clientIds))
      )
        .map((row) => row.clientId)
        .sort();

    it("deletes clients older than 7 days that never got a grant, and only those", async () => {
      const owner = await createWebUser("Olga Owner");
      await makeGroup("Team", owner.id, { organizationOwnerId: owner.id });
      const [organization] = await db
        .update(organizations)
        .set({ aiConnections: aiConnectionsLevel.Read })
        .where(eq(organizations.ownerUserId, owner.id))
        .returning({ id: organizations.id });
      await upsertSubscription(organization!.id, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });
      await syncEmployment(organization!.id, owner.id);

      const abandoned = ((await (await register()).json()) as { client_id: string }).client_id;
      const recent = ((await (await register()).json()) as { client_id: string }).client_id;
      const { clientId: granted } = await connectAiApp({
        serverUrl: server.url,
        email: owner.email,
        organizationId: organization!.id,
        scope: "flexiday.read offline_access",
      });
      const discovered = "https://app.example/oauth/client.json";
      await db.insert(oauthClient).values({
        id: uuidv4(),
        clientId: discovered,
        clientDiscoveryId: "cimd",
        redirectUris: ["https://app.example/callback"],
        createdAt: new Date(),
      });
      await backdate([abandoned, granted, discovered]);

      expect((await register()).status).toBe(201);

      expect(await remaining([abandoned, recent, granted, discovered])).toEqual(
        [recent, granted, discovered].sort()
      );
    });
  });
});

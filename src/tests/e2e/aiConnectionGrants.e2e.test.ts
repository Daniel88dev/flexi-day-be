import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
  type MockInstance,
} from "vitest";
import request from "supertest";
import { createHash, randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { base32 } from "@better-auth/utils/base32";
import { config } from "../../config.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { oauthConsent, oauthRefreshToken, verification } from "../../db/schema/auth-schema.js";
import { aiConnectionsLevel, organizations } from "../../db/schema/organization-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { auth } from "../../utils/auth.js";
import { checkAuthSecret } from "../../services/authSecret/authSecretServices.js";
import { authSecretFingerprint as authSecretFingerprintTable } from "../../db/schema/auth-secret-schema.js";
import { addMember, makeGroup, makeUser } from "./helpers/reportFixtures.js";
import { authCookieFor, createWebUser, WEB_TEST_PASSWORD } from "./helpers/authHelper.js";
import { cookieHeaderOf } from "./helpers/nativeSessionHelpers.js";
import { cleanupTestData } from "./helpers/testSetup.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

const CLAUDE_CLIENT_ID = "https://claude.ai/oauth/mcp-client-metadata";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CURSOR_REDIRECT = "http://localhost:51234/callback";

vi.mock("@better-auth/cimd/node", () => ({
  fetchClientMetadataResource: (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(
      url === "https://claude.ai/oauth/mcp-client-metadata"
        ? new Response(
            JSON.stringify({
              client_id: url,
              client_name: "Claude",
              client_uri: "https://claude.ai",
              redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        : new Response("not found", { status: 404 })
    );
  },
}));

const ON = { assistantEnabled: false, aiConnectionsEnabled: true, previewOrganizationIds: [] };
const OFF = { assistantEnabled: false, aiConnectionsEnabled: false, previewOrganizationIds: [] };
const ORIGIN = "http://localhost:3000";
const RESOURCE = `${config.api.publicUrl}/mcp`;
const ALL_SCOPES = "flexiday.read flexiday.write offline_access";
const READ_SCOPES = "flexiday.read offline_access";
const PWNED_RANGE = "https://api.pwnedpasswords.com/range/";

type Tokens = { clientId: string; refreshToken: string };

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
};

const queryOf = (url: string) => new URL(url).search.slice(1);

describe("Ending AI connections", () => {
  let server: LoopbackServer;
  let pwnedFetch: MockInstance<typeof fetch>;
  const savedSwitches = config.aiFeatures;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
    // `/change-password` and `/reset-password` ask Have I Been Pwned; answered offline.
    const realFetch = globalThis.fetch;
    pwnedFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (!url.startsWith(PWNED_RANGE)) return realFetch(input, init);
      return Promise.resolve(new Response("", { status: 200 }));
    });
  });

  beforeEach(async () => {
    await cleanupTestData();
    config.aiFeatures = { ...ON };
  });

  afterAll(async () => {
    pwnedFetch.mockRestore();
    config.aiFeatures = savedSwitches;
    await server?.close();
    await cleanupTestData();
  });

  const api = () => request(server.url);

  const post = (path: string, body: object, cookie?: string) => {
    const req = api().post(path).set("Origin", ORIGIN).set("Accept", "application/json");
    if (cookie) req.set("Cookie", cookie);
    return req.send(body);
  };

  const makeOrganization = async (name: string) => {
    const owner = await makeUser(`${name} Owner`);
    const groupId = await makeGroup(`${name} Team`, owner.id, { organizationOwnerId: owner.id });
    const [organization] = await db
      .update(organizations)
      .set({ name, aiConnections: aiConnectionsLevel.Write })
      .where(eq(organizations.ownerUserId, owner.id))
      .returning({ id: organizations.id });
    const organizationId = organization!.id;
    await syncEmployment(organizationId, owner.id);
    await upsertSubscription(organizationId, {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });
    return { organizationId, groupId, owner };
  };

  const join = async (organization: { organizationId: string; groupId: string }, id: string) => {
    await addMember(organization.groupId, id);
    await syncEmployment(organization.organizationId, id);
  };

  /** Jana and Petr belong to Acme and Beta, both Read and write on Pro. */
  const setUp = async () => {
    const acme = await makeOrganization("Acme");
    const beta = await makeOrganization("Beta");
    const jana = await createWebUser("Jana Member");
    const petr = await createWebUser("Petr Member");
    for (const person of [jana, petr]) {
      await join(acme, person.id);
      await join(beta, person.id);
    }
    return { acme, beta, jana, petr };
  };

  const registerCursor = async () => {
    const res = await api()
      .post("/api/auth/oauth2/register")
      .send({
        client_name: "Cursor",
        redirect_uris: ["http://localhost:8787/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.client_id as string;
  };

  const exchange = (body: Record<string, string>) =>
    api().post("/api/auth/oauth2/token").type("form").send(body);

  /** The whole flow from a signed-out browser to a refresh token for one organization. */
  const connect = async (args: {
    clientId: string;
    redirectUri: string;
    email: string;
    organizationId: string;
    scope?: string;
  }): Promise<Tokens & { cookie: string }> => {
    const { verifier, challenge } = pkce();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: args.clientId,
      redirect_uri: args.redirectUri,
      scope: ALL_SCOPES,
      state: "state-1",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
    });
    const login = await api().get(`/api/auth/oauth2/authorize?${query.toString()}`).redirects(0);
    expect(login.status, JSON.stringify(login.body)).toBe(302);

    const signedIn = await post("/api/auth/sign-in/email", {
      email: args.email,
      password: WEB_TEST_PASSWORD,
      oauth_query: queryOf(login.headers.location as string),
    });
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    const cookie = cookieHeaderOf(signedIn);

    const picked = await post(
      "/api/oauth-connect/organization",
      { organizationId: args.organizationId },
      cookie
    );
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    const continued = await post(
      "/api/auth/oauth2/continue",
      { postLogin: true, oauth_query: queryOf(signedIn.body.url as string) },
      cookie
    );
    expect(continued.status, JSON.stringify(continued.body)).toBe(200);
    const consented = await post(
      "/api/auth/oauth2/consent",
      {
        accept: true,
        oauth_query: queryOf(continued.body.url as string),
        scope: args.scope ?? ALL_SCOPES,
      },
      cookie
    );
    expect(consented.status, JSON.stringify(consented.body)).toBe(200);

    const redirect = new URL(consented.body.url as string);
    const tokens = await exchange({
      grant_type: "authorization_code",
      code: redirect.searchParams.get("code") ?? "",
      redirect_uri: args.redirectUri,
      client_id: args.clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(tokens.status, JSON.stringify(tokens.body)).toBe(200);
    return { clientId: args.clientId, refreshToken: tokens.body.refresh_token as string, cookie };
  };

  const refresh = (tokens: Tokens) =>
    exchange({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: tokens.clientId,
      resource: RESOURCE,
    });

  /** Refreshes, and hands back the rotated token so the grant can be refreshed again. */
  const expectAlive = async (tokens: Tokens): Promise<Tokens> => {
    const res = await refresh(tokens);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return { ...tokens, refreshToken: res.body.refresh_token as string };
  };

  const expectEnded = async (tokens: Tokens) => {
    const res = await refresh(tokens);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
  };

  const consentsOf = (userId: string) =>
    db.select().from(oauthConsent).where(eq(oauthConsent.userId, userId));

  const refreshTokensOf = (userId: string) =>
    db.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.userId, userId));

  describe("the Settings list", () => {
    it("lists the caller's grants with app, address, organization, access and last use", async () => {
      const { acme, beta, jana, petr } = await setUp();
      const cursorId = await registerCursor();
      await connect({
        clientId: CLAUDE_CLIENT_ID,
        redirectUri: CLAUDE_REDIRECT,
        email: jana.email,
        organizationId: acme.organizationId,
      });
      await connect({
        clientId: cursorId,
        redirectUri: CURSOR_REDIRECT,
        email: jana.email,
        organizationId: beta.organizationId,
        scope: READ_SCOPES,
      });
      await connect({
        clientId: CLAUDE_CLIENT_ID,
        redirectUri: CLAUDE_REDIRECT,
        email: petr.email,
        organizationId: acme.organizationId,
      });

      const res = await api()
        .get("/api/users/me/ai-connections")
        .set("Cookie", await authCookieFor(jana.id));

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.serverUrl).toBe(RESOURCE);
      expect(res.body.connections).toHaveLength(2);
      const rows = res.body.connections as { app: { clientId: string } }[];
      const cursor = rows.find((row) => row.app.clientId === cursorId);
      const claude = rows.find((row) => row.app.clientId === CLAUDE_CLIENT_ID);
      expect(cursor).toMatchObject({
        app: { clientId: cursorId, name: "Cursor", verified: false, host: "localhost:8787" },
        organizationId: beta.organizationId,
        organizationName: "Beta",
        access: "read",
      });
      expect(claude).toMatchObject({
        app: { clientId: CLAUDE_CLIENT_ID, name: "Claude", verified: true, host: "claude.ai" },
        organizationId: acme.organizationId,
        organizationName: "Acme",
        access: "write",
      });
      for (const row of [cursor, claude] as Record<string, unknown>[]) {
        expect(typeof row.grantId).toBe("string");
        expect(Date.parse(String(row.lastUsedAt))).toBeGreaterThanOrEqual(
          Date.parse(String(row.connectedAt))
        );
      }
    });

    it("moves last use forward when the app refreshes", async () => {
      const { acme, jana } = await setUp();
      const tokens = await connect({
        clientId: CLAUDE_CLIENT_ID,
        redirectUri: CLAUDE_REDIRECT,
        email: jana.email,
        organizationId: acme.organizationId,
      });
      const cookie = await authCookieFor(jana.id);
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await db
        .update(oauthRefreshToken)
        .set({ createdAt: twoHoursAgo })
        .where(eq(oauthRefreshToken.userId, jana.id));
      await db
        .update(oauthConsent)
        .set({ updatedAt: twoHoursAgo })
        .where(eq(oauthConsent.userId, jana.id));
      const lastUsed = async () =>
        Date.parse(
          (await api().get("/api/users/me/ai-connections").set("Cookie", cookie)).body
            .connections[0].lastUsedAt as string
        );
      expect(await lastUsed()).toBe(twoHoursAgo.getTime());

      await expectAlive(tokens);

      expect(await lastUsed()).toBeGreaterThan(Date.now() - 60 * 1000);
    });

    it("answers 404 while AI connections are unavailable", async () => {
      const { jana } = await setUp();
      config.aiFeatures = { ...OFF };
      const cookie = await authCookieFor(jana.id);

      expect((await api().get("/api/users/me/ai-connections").set("Cookie", cookie)).status).toBe(
        404
      );
      expect(
        (await api().delete(`/api/users/me/ai-connections/${uuidv4()}`).set("Cookie", cookie))
          .status
      ).toBe(404);
    });
  });

  describe("Disconnect", () => {
    it("ends one grant: its next refresh gets invalid_grant, the others keep working", async () => {
      const { acme, beta, jana } = await setUp();
      const inAcme = await connect({
        clientId: CLAUDE_CLIENT_ID,
        redirectUri: CLAUDE_REDIRECT,
        email: jana.email,
        organizationId: acme.organizationId,
      });
      const refreshed = await expectAlive(inAcme);
      const inBeta = await connect({
        clientId: CLAUDE_CLIENT_ID,
        redirectUri: CLAUDE_REDIRECT,
        email: jana.email,
        organizationId: beta.organizationId,
      });
      const cookie = await authCookieFor(jana.id);
      const listed = await api().get("/api/users/me/ai-connections").set("Cookie", cookie);
      const grant = (listed.body.connections as { grantId: string; organizationId: string }[]).find(
        (row) => row.organizationId === acme.organizationId
      );

      const res = await api()
        .delete(`/api/users/me/ai-connections/${grant!.grantId}`)
        .set("Cookie", cookie);

      expect(res.status).toBe(204);
      await expectEnded(refreshed);
      await expectEnded(inAcme);
      await expectAlive(inBeta);
      const left = await api().get("/api/users/me/ai-connections").set("Cookie", cookie);
      expect(
        (left.body.connections as { organizationId: string }[]).map((row) => row.organizationId)
      ).toEqual([beta.organizationId]);
      expect(
        (await refreshTokensOf(jana.id)).every((row) => row.referenceId === beta.organizationId)
      ).toBe(true);
    });

    it("answers 404 for someone else's grant and leaves it alone", async () => {
      const { acme, jana, petr } = await setUp();
      const janas = await connect({
        clientId: CLAUDE_CLIENT_ID,
        redirectUri: CLAUDE_REDIRECT,
        email: jana.email,
        organizationId: acme.organizationId,
      });
      const [consent] = await consentsOf(jana.id);

      const res = await api()
        .delete(`/api/users/me/ai-connections/${consent!.id}`)
        .set("Cookie", await authCookieFor(petr.id));

      expect(res.status).toBe(404);
      await expectAlive(janas);
    });
  });

  describe("the user's own events", () => {
    const connectBoth = async () => {
      const world = await setUp();
      const janaAcme = await connect({
        clientId: CLAUDE_CLIENT_ID,
        redirectUri: CLAUDE_REDIRECT,
        email: world.jana.email,
        organizationId: world.acme.organizationId,
      });
      const janaBeta = await connect({
        clientId: CLAUDE_CLIENT_ID,
        redirectUri: CLAUDE_REDIRECT,
        email: world.jana.email,
        organizationId: world.beta.organizationId,
      });
      const petrAcme = await connect({
        clientId: CLAUDE_CLIENT_ID,
        redirectUri: CLAUDE_REDIRECT,
        email: world.petr.email,
        organizationId: world.acme.organizationId,
      });
      return { ...world, janaAcme, janaBeta, petrAcme };
    };

    it("a password reset deletes every grant the user holds", async () => {
      const { jana, janaAcme, janaBeta, petrAcme } = await connectBoth();
      const token = `tok-${uuidv4()}`;
      await db.insert(verification).values({
        id: uuidv4(),
        identifier: `reset-password:${token}`,
        value: jana.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await auth.api.resetPassword({ body: { newPassword: "Str0ng-Reset-Pass-9182", token } });

      await expectEnded(janaAcme);
      await expectEnded(janaBeta);
      expect(await consentsOf(jana.id)).toEqual([]);
      expect(await refreshTokensOf(jana.id)).toEqual([]);
      await expectAlive(petrAcme);
    });

    it("a password change that signs out the other sessions deletes them", async () => {
      const { jana, janaAcme, janaBeta, petrAcme } = await connectBoth();

      const res = await post(
        "/api/auth/change-password",
        {
          currentPassword: WEB_TEST_PASSWORD,
          newPassword: "another-sturdy-passphrase-73",
          revokeOtherSessions: true,
        },
        janaAcme.cookie
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectEnded(janaAcme);
      await expectEnded(janaBeta);
      expect(await consentsOf(jana.id)).toEqual([]);
      await expectAlive(petrAcme);
    });

    it("a password change that keeps the other sessions keeps them, as does a failed one", async () => {
      const { jana, janaAcme } = await connectBoth();

      const wrong = await post(
        "/api/auth/change-password",
        {
          currentPassword: "not-the-password-at-all",
          newPassword: "another-sturdy-passphrase-73",
          revokeOtherSessions: true,
        },
        janaAcme.cookie
      );
      expect(wrong.status).toBe(400);
      const kept = await post(
        "/api/auth/change-password",
        { currentPassword: WEB_TEST_PASSWORD, newPassword: "another-sturdy-passphrase-73" },
        janaAcme.cookie
      );
      expect(kept.status, JSON.stringify(kept.body)).toBe(200);

      await expectAlive(janaAcme);
      expect(await consentsOf(jana.id)).toHaveLength(2);
    });

    it("account deletion deletes them in its own transaction", async () => {
      const { jana, janaAcme, janaBeta, petrAcme } = await connectBoth();

      const res = await api()
        .post("/api/users/me/delete")
        .set("Cookie", await authCookieFor(jana.id))
        .send({ password: WEB_TEST_PASSWORD });

      expect(res.status, JSON.stringify(res.body)).toBe(204);
      await expectEnded(janaAcme);
      await expectEnded(janaBeta);
      expect(await consentsOf(jana.id)).toEqual([]);
      expect(await refreshTokensOf(jana.id)).toEqual([]);
      await expectAlive(petrAcme);
    });

    it("sign-out keeps them", async () => {
      const { jana, janaAcme } = await connectBoth();

      const res = await post("/api/auth/sign-out", {}, janaAcme.cookie);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectAlive(janaAcme);
      expect(await consentsOf(jana.id)).toHaveLength(2);
    });

    it("an auth-secret rotation keeps them, though it deletes every session", async () => {
      const { jana, janaAcme } = await connectBoth();
      await db.delete(authSecretFingerprintTable);
      await checkAuthSecret("grants-secret-before");

      expect((await checkAuthSecret("grants-secret-after")).outcome).toBe("rotated");

      await db.delete(authSecretFingerprintTable);
      await expectAlive(janaAcme);
      expect(await consentsOf(jana.id)).toHaveLength(2);
    });

    it("turning two-factor on keeps them", async () => {
      const { jana, janaAcme } = await connectBoth();
      const cookie = await authCookieFor(jana.id);
      const enabled = await post(
        "/api/auth/two-factor/enable",
        { password: WEB_TEST_PASSWORD },
        cookie
      );
      expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
      const secret = new URL(enabled.body.totpURI as string).searchParams.get("secret") ?? "";
      const { code } = await auth.api.generateTOTP({
        body: { secret: new TextDecoder().decode(base32.decode(secret)) },
      });

      const verified = await post("/api/auth/two-factor/verify-totp", { code }, cookie);

      expect(verified.status, JSON.stringify(verified.body)).toBe(200);
      await expectAlive(janaAcme);
      expect(await consentsOf(jana.id)).toHaveLength(2);
    });
  });

  describe("the owner's setting", () => {
    const connectWorld = async () => {
      const world = await setUp();
      const cursorId = await registerCursor();
      const janaClaude = await connect({
        clientId: CLAUDE_CLIENT_ID,
        redirectUri: CLAUDE_REDIRECT,
        email: world.jana.email,
        organizationId: world.acme.organizationId,
      });
      const petrCursorRead = await connect({
        clientId: cursorId,
        redirectUri: CURSOR_REDIRECT,
        email: world.petr.email,
        organizationId: world.acme.organizationId,
        scope: READ_SCOPES,
      });
      const janaBeta = await connect({
        clientId: CLAUDE_CLIENT_ID,
        redirectUri: CLAUDE_REDIRECT,
        email: world.jana.email,
        organizationId: world.beta.organizationId,
      });
      return { ...world, cursorId, janaClaude, petrCursorRead, janaBeta };
    };

    const asOwner = async (ownerId: string, organizationId: string, path: string, body = {}) =>
      api()
        .post(`/api/organization/ai/connections/${path}?organizationId=${organizationId}`)
        .set("Cookie", await authCookieFor(ownerId))
        .send(body);

    it("names every grant in the organization for the owner's dialogs", async () => {
      const { acme, cursorId } = await connectWorld();

      const res = await api()
        .get(`/api/organization/ai?organizationId=${acme.organizationId}`)
        .set("Cookie", await authCookieFor(acme.owner.id));

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(
        (
          res.body.aiConnections.grants as {
            app: { name: string; clientId: string };
            personName: string;
            access: string;
          }[]
        ).map((grant) => [grant.app.name, grant.app.clientId, grant.personName, grant.access])
      ).toEqual([
        ["Claude", CLAUDE_CLIENT_ID, "Jana Member", "write"],
        ["Cursor", cursorId, "Petr Member", "read"],
      ]);
    });

    it("lowering to Read only deletes only the write grants, in this organization only", async () => {
      const { acme, janaClaude, petrCursorRead, janaBeta } = await connectWorld();

      const res = await asOwner(acme.owner.id, acme.organizationId, "level", { level: "read" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(
        (res.body.aiConnections.grants as { personName: string }[]).map((g) => g.personName)
      ).toEqual(["Petr Member"]);
      await expectEnded(janaClaude);
      await expectAlive(petrCursorRead);
      await expectAlive(janaBeta);
    });

    it("raising back to Read and write deletes nothing", async () => {
      const { acme, janaClaude, petrCursorRead } = await connectWorld();
      await db
        .update(organizations)
        .set({ aiConnections: aiConnectionsLevel.Read })
        .where(eq(organizations.id, acme.organizationId));

      const res = await asOwner(acme.owner.id, acme.organizationId, "level", { level: "write" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectAlive(janaClaude);
      await expectAlive(petrCursorRead);
    });

    it("turning off deletes every grant in the organization and none elsewhere", async () => {
      const { acme, jana, janaClaude, petrCursorRead, janaBeta } = await connectWorld();

      const res = await asOwner(acme.owner.id, acme.organizationId, "disable");

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.aiConnections.grants).toEqual([]);
      await expectEnded(janaClaude);
      await expectEnded(petrCursorRead);
      await expectAlive(janaBeta);
      expect((await consentsOf(jana.id)).map((row) => row.referenceId)).toEqual([
        expect.not.stringMatching(acme.organizationId),
      ]);
    });

    it("a refused change deletes nothing", async () => {
      const { acme, petr, janaClaude } = await connectWorld();

      const res = await asOwner(petr.id, acme.organizationId, "disable");

      expect(res.status).toBe(403);
      await expectAlive(janaClaude);
    });
  });
});

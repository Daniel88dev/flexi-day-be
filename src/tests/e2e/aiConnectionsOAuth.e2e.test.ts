import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";
import { base32 } from "@better-auth/utils/base32";
import { config } from "../../config.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import {
  oauthConsent,
  session as sessionTable,
  user,
  verification,
} from "../../db/schema/auth-schema.js";
import { aiConnectionsLevel, organizations } from "../../db/schema/organization-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { auth } from "../../utils/auth.js";
import { aiEligibility } from "../../services/aiFeatures/aiEligibility.js";
import { addMember, makeGroup, makeUser } from "./helpers/reportFixtures.js";
import { createWebUser, WEB_TEST_PASSWORD, authCookieFor } from "./helpers/authHelper.js";
import { cookieHeaderOf } from "./helpers/nativeSessionHelpers.js";
import { cleanupTestData } from "./helpers/testSetup.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

const CLAUDE_CLIENT_ID = "https://claude.ai/oauth/mcp-client-metadata";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

/** Client ID Metadata Documents the fake transport serves; nothing leaves the process. */
const metadataDocuments = new Map<string, object>([
  [
    CLAUDE_CLIENT_ID,
    {
      client_id: CLAUDE_CLIENT_ID,
      client_name: "Claude",
      client_uri: "https://claude.ai",
      logo_uri: "https://claude.ai/logo.png",
      policy_uri: "http://claude.ai/privacy",
      redirect_uris: [CLAUDE_REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  ],
]);

vi.mock("@better-auth/cimd/node", () => ({
  fetchClientMetadataResource: (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const document = metadataDocuments.get(url);
    return Promise.resolve(
      document
        ? new Response(JSON.stringify(document), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response("not found", { status: 404 })
    );
  },
}));

const ON = { assistantEnabled: false, aiConnectionsEnabled: true, previewOrganizationIds: [] };
const OFF = { assistantEnabled: false, aiConnectionsEnabled: false, previewOrganizationIds: [] };
const ORIGIN = "http://localhost:3000";
const RESOURCE = `${config.api.publicUrl}/mcp`;
const ISSUER = `${config.api.publicUrl}/api/auth`;
const ORGANIZATION_CLAIM = "https://flexi-day.com/organization";
const ALL_SCOPES = "flexiday.read flexiday.write offline_access";

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
};

const queryOf = (url: string) => new URL(url).search.slice(1);

describe("Connecting an AI app over OAuth", () => {
  let server: LoopbackServer;
  const savedSwitches = config.aiFeatures;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    await cleanupTestData();
    config.aiFeatures = { ...ON };
  });

  afterAll(async () => {
    config.aiFeatures = savedSwitches;
    await server?.close();
    await cleanupTestData();
  });

  const api = () => request(server.url);

  const makeOrganization = async (
    name: string,
    level: aiConnectionsLevel,
    plan: subscriptionPlan | null
  ) => {
    const owner = await makeUser(`${name} Owner`);
    const groupId = await makeGroup(`${name} Team`, owner.id, { organizationOwnerId: owner.id });
    const [organization] = await db
      .update(organizations)
      .set({ name, aiConnections: level })
      .where(eq(organizations.ownerUserId, owner.id))
      .returning({ id: organizations.id });
    const organizationId = organization!.id;
    await syncEmployment(organizationId, owner.id);
    if (plan) {
      await upsertSubscription(organizationId, {
        plan,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });
    }
    return { organizationId, groupId, owner };
  };

  /** Jana belongs to Acme (Read and write), Beta (Read only), Gamma (Off) and Delta (Free). */
  const setUp = async () => {
    const acme = await makeOrganization("Acme", aiConnectionsLevel.Write, subscriptionPlan.Pro);
    const beta = await makeOrganization("Beta", aiConnectionsLevel.Read, subscriptionPlan.Pro);
    const gamma = await makeOrganization("Gamma", aiConnectionsLevel.Off, subscriptionPlan.Pro);
    const delta = await makeOrganization("Delta", aiConnectionsLevel.Write, null);
    const jana = await createWebUser("Jana Member");
    for (const organization of [acme, beta, gamma, delta]) {
      await addMember(organization.groupId, jana.id);
      await syncEmployment(organization.organizationId, jana.id);
    }
    return { acme, beta, gamma, delta, jana };
  };

  const registerClient = async (body: object) => {
    const res = await api()
      .post("/api/auth/oauth2/register")
      .send({
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...body,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.client_id as string;
  };

  const authorize = async (
    clientId: string,
    redirectUri: string,
    challenge: string,
    cookie?: string,
    scope = ALL_SCOPES
  ) => {
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      state: "state-123",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
    });
    const req = api().get(`/api/auth/oauth2/authorize?${query.toString()}`).redirects(0);
    if (cookie) req.set("Cookie", cookie);
    const res = await req;
    expect(res.status, JSON.stringify(res.body)).toBe(302);
    return res.headers.location as string;
  };

  const post = (path: string, body: object, cookie?: string) => {
    const req = api().post(path).set("Origin", ORIGIN).set("Accept", "application/json");
    if (cookie) req.set("Cookie", cookie);
    return req.send(body);
  };

  const context = (oauthQuery: string, cookie?: string) =>
    post("/api/oauth-connect/context", { oauthQuery }, cookie);

  const signIn = (email: string, oauthQuery: string) =>
    post("/api/auth/sign-in/email", {
      email,
      password: WEB_TEST_PASSWORD,
      oauth_query: oauthQuery,
    });

  const pick = (organizationId: string, cookie: string) =>
    post("/api/oauth-connect/organization", { organizationId }, cookie);

  const continueAfterPicker = (oauthQuery: string, cookie: string) =>
    post("/api/auth/oauth2/continue", { postLogin: true, oauth_query: oauthQuery }, cookie);

  const consent = (oauthQuery: string, cookie: string, scope?: string) =>
    post(
      "/api/auth/oauth2/consent",
      { accept: true, oauth_query: oauthQuery, ...(scope ? { scope } : {}) },
      cookie
    );

  const exchange = (body: Record<string, string>) =>
    api().post("/api/auth/oauth2/token").type("form").send(body);

  const verifyAccessToken = async (token: string): Promise<JWTPayload> => {
    const jwks = await api().get("/api/auth/jwks");
    expect(jwks.status).toBe(200);
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks.body), {
      issuer: ISSUER,
      audience: RESOURCE,
    });
    return payload;
  };

  /** Sign-in, picker and consent for a signed-out browser, ending at the app's redirect. */
  const connect = async (args: {
    clientId: string;
    redirectUri: string;
    email: string;
    organizationId: string;
    consentScope?: string;
  }) => {
    const { verifier, challenge } = pkce();
    const loginUrl = await authorize(args.clientId, args.redirectUri, challenge);
    expect(loginUrl.startsWith(`${ORIGIN}/oauth/sign-in/?`)).toBe(true);

    const signedIn = await signIn(args.email, queryOf(loginUrl));
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    const cookie = cookieHeaderOf(signedIn);
    const pickerUrl = signedIn.body.url as string;
    expect(pickerUrl.startsWith(`${ORIGIN}/oauth/organization/?`)).toBe(true);

    expect((await pick(args.organizationId, cookie)).status).toBe(200);
    const continued = await continueAfterPicker(queryOf(pickerUrl), cookie);
    expect(continued.status, JSON.stringify(continued.body)).toBe(200);
    const consentUrl = continued.body.url as string;
    expect(consentUrl.startsWith(`${ORIGIN}/oauth/consent/?`)).toBe(true);

    const consented = await consent(queryOf(consentUrl), cookie, args.consentScope);
    return { verifier, cookie, consentUrl, consented };
  };

  const redeem = async (args: {
    clientId: string;
    redirectUri: string;
    verifier: string;
    redirectedTo: string;
  }) => {
    const redirect = new URL(args.redirectedTo);
    expect(redirect.searchParams.get("state")).toBe("state-123");
    expect(redirect.searchParams.get("iss")).toBe(ISSUER);
    const res = await exchange({
      grant_type: "authorization_code",
      code: redirect.searchParams.get("code") ?? "",
      redirect_uri: args.redirectUri,
      client_id: args.clientId,
      code_verifier: args.verifier,
      resource: RESOURCE,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { access_token: string; refresh_token: string; scope: string };
  };

  describe("discovery", () => {
    it("serves RFC 8414 metadata at the issuer path, advertising CIMD and DCR", async () => {
      const res = await api().get("/.well-known/oauth-authorization-server/api/auth");

      expect(res.status).toBe(200);
      expect(res.body.issuer).toBe(ISSUER);
      expect(res.body.client_id_metadata_document_supported).toBe(true);
      expect(res.body.registration_endpoint).toBe(`${ISSUER}/oauth2/register`);
      expect(res.body.token_endpoint_auth_methods_supported).toContain("none");
      expect(res.body.authorization_response_iss_parameter_supported).toBe(true);
      expect(res.body.scopes_supported).toEqual(
        expect.arrayContaining(["flexiday.read", "flexiday.write", "offline_access"])
      );
    });

    it("serves protected-resource metadata for /mcp without offline_access", async () => {
      for (const path of [
        "/.well-known/oauth-protected-resource/mcp",
        "/.well-known/oauth-protected-resource",
      ]) {
        const res = await api().get(path);

        expect(res.status, path).toBe(200);
        expect(res.body.resource).toBe(RESOURCE);
        expect(res.body.authorization_servers).toEqual([ISSUER]);
        expect(res.body.scopes_supported).toEqual(["flexiday.read", "flexiday.write"]);
      }
    });

    it("answers 404 everywhere while AI connections are unavailable", async () => {
      config.aiFeatures = { ...OFF };

      for (const path of [
        "/.well-known/oauth-authorization-server/api/auth",
        "/.well-known/oauth-protected-resource/mcp",
        "/api/auth/.well-known/oauth-authorization-server",
        "/api/auth/jwks",
        "/api/auth/oauth2/authorize?client_id=x",
      ]) {
        expect((await api().get(path)).status, path).toBe(404);
      }
      expect(
        (
          await api()
            .post("/api/auth/oauth2/register")
            .send({ redirect_uris: [CLAUDE_REDIRECT] })
        ).status
      ).toBe(404);
      expect((await context("client_id=x&sig=y")).status).toBe(404);
    });
  });

  describe("the whole flow", () => {
    it("connects a CIMD client and ends with a token for the picked organization and both scopes", async () => {
      const { acme, beta, gamma, delta, jana } = await setUp();
      const { verifier, challenge } = pkce();
      const loginUrl = await authorize(CLAUDE_CLIENT_ID, CLAUDE_REDIRECT, challenge);

      const before = await context(queryOf(loginUrl));
      expect(before.status, JSON.stringify(before.body)).toBe(200);
      expect(before.body).toMatchObject({
        client: {
          clientId: CLAUDE_CLIENT_ID,
          name: "Claude",
          verified: true,
          host: "claude.ai",
          logoUri: "https://claude.ai/logo.png",
          clientUri: "https://claude.ai",
          // Only https links reach the page.
          policyUri: null,
        },
        redirect: { host: "claude.ai", local: false },
        scopes: ["flexiday.read", "flexiday.write"],
        signedIn: false,
        organization: null,
        organizations: null,
      });

      const signedIn = await signIn(jana.email, queryOf(loginUrl));
      expect(signedIn.status).toBe(200);
      const cookie = cookieHeaderOf(signedIn);
      const pickerUrl = signedIn.body.url as string;
      expect(pickerUrl.startsWith(`${ORIGIN}/oauth/organization/?`)).toBe(true);

      const picker = await context(queryOf(pickerUrl), cookie);
      expect(picker.body.signedIn).toBe(true);
      expect(picker.body.organizations).toEqual({
        eligible: [
          { organizationId: acme.organizationId, organizationName: "Acme", access: "write" },
          { organizationId: beta.organizationId, organizationName: "Beta", access: "read" },
        ],
        leftOut: [
          {
            organizationId: gamma.organizationId,
            organizationName: "Gamma",
            ownerName: "Gamma Owner",
            reason: "TURNED_OFF",
          },
          {
            organizationId: delta.organizationId,
            organizationName: "Delta",
            ownerName: "Delta Owner",
            reason: "PLAN",
          },
        ],
      });

      expect((await pick(gamma.organizationId, cookie)).status).toBe(403);
      const picked = await pick(acme.organizationId, cookie);
      expect(picked.body).toEqual({
        organizationId: acme.organizationId,
        organizationName: "Acme",
        access: "write",
      });

      const continued = await continueAfterPicker(queryOf(pickerUrl), cookie);
      const consentUrl = continued.body.url as string;
      expect(consentUrl.startsWith(`${ORIGIN}/oauth/consent/?`)).toBe(true);
      const consentPage = await context(queryOf(consentUrl), cookie);
      expect(consentPage.body.organization).toEqual(picked.body);

      const consented = await consent(queryOf(consentUrl), cookie);
      expect(consented.status, JSON.stringify(consented.body)).toBe(200);
      const tokens = await redeem({
        clientId: CLAUDE_CLIENT_ID,
        redirectUri: CLAUDE_REDIRECT,
        verifier,
        redirectedTo: consented.body.url,
      });

      expect(tokens.scope.split(" ").sort()).toEqual([
        "flexiday.read",
        "flexiday.write",
        "offline_access",
      ]);
      const claims = await verifyAccessToken(tokens.access_token);
      expect(claims).toMatchObject({
        sub: jana.id,
        azp: CLAUDE_CLIENT_ID,
        [ORGANIZATION_CLAIM]: acme.organizationId,
      });
      expect(String(claims.scope).split(" ")).toEqual(
        expect.arrayContaining(["flexiday.read", "flexiday.write"])
      );

      const [stored] = await db.select().from(oauthConsent).where(eq(oauthConsent.userId, jana.id));
      expect(stored?.referenceId).toBe(acme.organizationId);

      const refreshed = await exchange({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: CLAUDE_CLIENT_ID,
        resource: RESOURCE,
      });
      expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
      expect(refreshed.body.refresh_token).not.toBe(tokens.refresh_token);
      expect((await verifyAccessToken(refreshed.body.access_token))[ORGANIZATION_CLAIM]).toBe(
        acme.organizationId
      );
    });

    it("registers Cursor through DCR and accepts its loopback callback on any port", async () => {
      const { acme, jana } = await setUp();
      const clientId = await registerClient({
        client_name: "Cursor",
        redirect_uris: ["http://localhost:8787/callback"],
      });
      const redirectUri = "http://localhost:51234/callback";

      const { verifier, consentUrl, consented, cookie } = await connect({
        clientId,
        redirectUri,
        email: jana.email,
        organizationId: acme.organizationId,
      });
      const page = await context(queryOf(consentUrl), cookie);
      expect(page.body.client).toMatchObject({ name: "Cursor", verified: false });
      expect(page.body.redirect).toEqual({ host: "localhost:51234", local: true });

      const tokens = await redeem({
        clientId,
        redirectUri,
        verifier,
        redirectedTo: consented.body.url,
      });
      expect((await verifyAccessToken(tokens.access_token))[ORGANIZATION_CLAIM]).toBe(
        acme.organizationId
      );
    });

    it("hands ChatGPT's connector callback the issuer it checks", async () => {
      const { acme, jana } = await setUp();
      const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
      const clientId = await registerClient({
        client_name: "ChatGPT",
        redirect_uris: [redirectUri],
      });

      const { verifier, consented } = await connect({
        clientId,
        redirectUri,
        email: jana.email,
        organizationId: acme.organizationId,
      });

      // `redeem` asserts `iss` on the redirect.
      await redeem({ clientId, redirectUri, verifier, redirectedTo: consented.body.url });
    });

    it("lets the member leave out write access", async () => {
      const { acme, jana } = await setUp();
      const { verifier, consented } = await connect({
        clientId: CLAUDE_CLIENT_ID,
        redirectUri: CLAUDE_REDIRECT,
        email: jana.email,
        organizationId: acme.organizationId,
        consentScope: "flexiday.read offline_access",
      });

      const tokens = await redeem({
        clientId: CLAUDE_CLIENT_ID,
        redirectUri: CLAUDE_REDIRECT,
        verifier,
        redirectedTo: consented.body.url,
      });
      expect(tokens.scope.split(" ")).not.toContain("flexiday.write");
    });

    it("asks for the organization again on the next authorization, even with a consent on file", async () => {
      const { acme, jana } = await setUp();
      const { cookie, consented } = await connect({
        clientId: CLAUDE_CLIENT_ID,
        redirectUri: CLAUDE_REDIRECT,
        email: jana.email,
        organizationId: acme.organizationId,
      });
      expect(consented.status).toBe(200);

      const next = await authorize(CLAUDE_CLIENT_ID, CLAUDE_REDIRECT, pkce().challenge, cookie);

      expect(next.startsWith(`${ORIGIN}/oauth/organization/?`)).toBe(true);
      const sessions = await db
        .select({ chosen: sessionTable.oauthOrganizationId })
        .from(sessionTable)
        .where(eq(sessionTable.userId, jana.id));
      expect(sessions.map((s) => s.chosen)).toEqual([null]);
    });
  });

  describe("Read only", () => {
    it("never grants flexiday.write, whatever the consent posts", async () => {
      const { beta, jana } = await setUp();
      const { verifier, consentUrl, consented, cookie } = await connect({
        clientId: CLAUDE_CLIENT_ID,
        redirectUri: CLAUDE_REDIRECT,
        email: jana.email,
        organizationId: beta.organizationId,
        consentScope: ALL_SCOPES,
      });
      expect(consented.status, JSON.stringify(consented.body)).toBe(200);
      expect((await context(queryOf(consentUrl), cookie)).body.organization.access).toBe("read");

      const tokens = await redeem({
        clientId: CLAUDE_CLIENT_ID,
        redirectUri: CLAUDE_REDIRECT,
        verifier,
        redirectedTo: consented.body.url,
      });
      expect(tokens.scope.split(" ")).not.toContain("flexiday.write");
      expect(String((await verifyAccessToken(tokens.access_token)).scope)).not.toContain(
        "flexiday.write"
      );
      const [stored] = await db.select().from(oauthConsent).where(eq(oauthConsent.userId, jana.id));
      expect(stored?.scopes).not.toContain("flexiday.write");
    });

    it("drops write from a consent that names no scopes", async () => {
      const { beta, jana } = await setUp();
      const { verifier, consented } = await connect({
        clientId: CLAUDE_CLIENT_ID,
        redirectUri: CLAUDE_REDIRECT,
        email: jana.email,
        organizationId: beta.organizationId,
      });

      const tokens = await redeem({
        clientId: CLAUDE_CLIENT_ID,
        redirectUri: CLAUDE_REDIRECT,
        verifier,
        redirectedTo: consented.body.url,
      });
      expect(tokens.scope.split(" ").sort()).toEqual(["flexiday.read", "offline_access"]);
    });
  });

  describe("eligibility between picker and consent", () => {
    it("refuses consent once the owner turned AI connections off, and issues no code", async () => {
      const { acme, jana } = await setUp();
      const { verifier, challenge } = pkce();
      void verifier;
      const loginUrl = await authorize(CLAUDE_CLIENT_ID, CLAUDE_REDIRECT, challenge);
      const signedIn = await signIn(jana.email, queryOf(loginUrl));
      const cookie = cookieHeaderOf(signedIn);
      await pick(acme.organizationId, cookie);
      const continued = await continueAfterPicker(queryOf(signedIn.body.url), cookie);
      const consentUrl = continued.body.url as string;

      await db
        .update(organizations)
        .set({ aiConnections: aiConnectionsLevel.Off })
        .where(eq(organizations.id, acme.organizationId));
      const res = await consent(queryOf(consentUrl), cookie);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("access_denied");
      expect(JSON.stringify(res.body)).not.toContain("code=");
      expect(await db.select().from(oauthConsent).where(eq(oauthConsent.userId, jana.id))).toEqual(
        []
      );
    });

    it("refuses consent once the plan lapsed to Free", async () => {
      const { acme, jana } = await setUp();
      const loginUrl = await authorize(CLAUDE_CLIENT_ID, CLAUDE_REDIRECT, pkce().challenge);
      const signedIn = await signIn(jana.email, queryOf(loginUrl));
      const cookie = cookieHeaderOf(signedIn);
      await pick(acme.organizationId, cookie);
      const continued = await continueAfterPicker(queryOf(signedIn.body.url), cookie);

      await upsertSubscription(acme.organizationId, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Canceled,
        graceEndsAt: null,
      });
      const res = await consent(queryOf(continued.body.url), cookie);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("access_denied");
    });

    it("sends the app access_denied when the member cancels on the picker", async () => {
      const { jana } = await setUp();
      const loginUrl = await authorize(CLAUDE_CLIENT_ID, CLAUDE_REDIRECT, pkce().challenge);
      const signedIn = await signIn(jana.email, queryOf(loginUrl));
      const cookie = cookieHeaderOf(signedIn);

      const res = await post(
        "/api/auth/oauth2/consent",
        { accept: false, oauth_query: queryOf(signedIn.body.url) },
        cookie
      );

      const back = new URL(res.body.url as string);
      expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_REDIRECT);
      expect(back.searchParams.get("error")).toBe("access_denied");
      expect(back.searchParams.get("code")).toBeNull();
    });

    it("sends a continue without an eligible choice back to the picker", async () => {
      const { jana } = await setUp();
      const loginUrl = await authorize(CLAUDE_CLIENT_ID, CLAUDE_REDIRECT, pkce().challenge);
      const signedIn = await signIn(jana.email, queryOf(loginUrl));
      const cookie = cookieHeaderOf(signedIn);

      const continued = await continueAfterPicker(queryOf(signedIn.body.url), cookie);

      expect(String(continued.body.url).startsWith(`${ORIGIN}/oauth/organization/?`)).toBe(true);
    });
  });

  describe("the eligibility resolver", () => {
    it("answers for the Assistant too: on, Enterprise, and standing", async () => {
      const { acme, beta, jana } = await setUp();
      const outsider = await makeUser("Olga Outsider");
      await upsertSubscription(acme.organizationId, {
        plan: subscriptionPlan.Enterprise,
        status: subscriptionStatus.Active,
        graceEndsAt: null,
      });
      await db
        .update(organizations)
        .set({ assistantEnabled: true })
        .where(eq(organizations.id, acme.organizationId));
      await db
        .update(organizations)
        .set({ assistantEnabled: true })
        .where(eq(organizations.id, beta.organizationId));
      config.aiFeatures = { ...ON, assistantEnabled: true };
      const ask = (userId: string, organizationId: string) =>
        aiEligibility({ userId, organizationId, feature: "assistant" });

      expect(await ask(jana.id, acme.organizationId)).toMatchObject({
        eligible: true,
        access: null,
      });
      expect(await ask(jana.id, beta.organizationId)).toMatchObject({ reason: "PLAN" });
      expect(await ask(outsider.id, acme.organizationId)).toMatchObject({ reason: "NO_STANDING" });

      config.aiFeatures = { ...OFF, previewOrganizationIds: [beta.organizationId] };
      expect(await ask(jana.id, acme.organizationId)).toMatchObject({ reason: "UNAVAILABLE" });
    });
  });

  describe("the signed query", () => {
    it("is refused by the context route when altered", async () => {
      await setUp();
      const loginUrl = await authorize(CLAUDE_CLIENT_ID, CLAUDE_REDIRECT, pkce().challenge);
      const altered = queryOf(loginUrl).replace("state-123", "state-999");

      const res = await context(altered);

      expect(res.status).toBe(400);
      expect(res.body.errors?.[0]?.context?.code).toBe("INVALID_OAUTH_QUERY");
    });
  });

  describe("two-factor", () => {
    const totpFor = async (userId: string) => {
      const cookie = await authCookieFor(userId);
      const enabled = await post(
        "/api/auth/two-factor/enable",
        { password: WEB_TEST_PASSWORD },
        cookie
      );
      expect(enabled.status).toBe(200);
      const secret = new URL(enabled.body.totpURI as string).searchParams.get("secret") ?? "";
      const raw = new TextDecoder().decode(base32.decode(secret));
      const code = async () => (await auth.api.generateTOTP({ body: { secret: raw } })).code;
      const verified = await post(
        "/api/auth/two-factor/verify-totp",
        { code: await code() },
        cookie
      );
      expect(verified.status).toBe(200);
      const [row] = await db.select().from(user).where(eq(user.id, userId));
      expect(row?.twoFactorEnabled).toBe(true);
      return code;
    };

    const codesFor = (userId: string) =>
      db
        .select()
        .from(verification)
        .where(
          and(
            like(verification.value, '%"type":"authorization_code"%'),
            like(verification.value, `%"userId":"${userId}"%`)
          )
        );

    it("yields no code from a password sign-in until the challenge passes", async () => {
      const { acme, jana } = await setUp();
      const totp = await totpFor(jana.id);
      const { verifier, challenge } = pkce();
      const loginUrl = await authorize(CLAUDE_CLIENT_ID, CLAUDE_REDIRECT, challenge);

      const signedIn = await signIn(jana.email, queryOf(loginUrl));

      expect(signedIn.status).toBe(200);
      expect(signedIn.body.twoFactorRedirect).toBe(true);
      expect(signedIn.body.url).toBeUndefined();
      expect(signedIn.headers.location).toBeUndefined();
      expect(JSON.stringify(signedIn.body)).not.toContain("code=");
      expect(await codesFor(jana.id)).toEqual([]);
      const challengeCookie = cookieHeaderOf(signedIn);
      expect((await context(queryOf(loginUrl), challengeCookie)).body.signedIn).toBe(false);

      // A navigation would carry the next step in `Location`, which survives
      // the challenge replacing the body; that is what `mcp()` after
      // `twoFactor` prevents.
      const navigated = await api()
        .post("/api/auth/sign-in/email")
        .set("Origin", ORIGIN)
        .set("Sec-Fetch-Mode", "navigate")
        .redirects(0)
        .send({ email: jana.email, password: WEB_TEST_PASSWORD, oauth_query: queryOf(loginUrl) });
      expect(navigated.body.twoFactorRedirect).toBe(true);
      expect(navigated.headers.location).toBeUndefined();

      const verified = await post(
        "/api/auth/two-factor/verify-totp",
        { code: await totp(), oauth_query: queryOf(loginUrl) },
        challengeCookie
      );
      expect(verified.status, JSON.stringify(verified.body)).toBe(200);
      const pickerUrl = verified.body.url as string;
      expect(pickerUrl.startsWith(`${ORIGIN}/oauth/organization/?`)).toBe(true);
      expect(await codesFor(jana.id)).toEqual([]);

      const cookie = cookieHeaderOf(verified);
      await pick(acme.organizationId, cookie);
      const continued = await continueAfterPicker(queryOf(pickerUrl), cookie);
      const consented = await consent(queryOf(continued.body.url), cookie);
      const tokens = await redeem({
        clientId: CLAUDE_CLIENT_ID,
        redirectUri: CLAUDE_REDIRECT,
        verifier,
        redirectedTo: consented.body.url,
      });
      expect((await verifyAccessToken(tokens.access_token))[ORGANIZATION_CLAIM]).toBe(
        acme.organizationId
      );
    });
  });
});

import request from "supertest";
import { createHash, randomBytes } from "node:crypto";
import { config } from "../../../config.js";
import { WEB_TEST_PASSWORD } from "./authHelper.js";
import { cookieHeaderOf } from "./nativeSessionHelpers.js";

const ORIGIN = "http://localhost:3000";
const REDIRECT_URI = "http://localhost:51234/callback";
export const MCP_RESOURCE = `${config.api.publicUrl}/mcp`;

const queryOf = (url: string) => new URL(url).search.slice(1);

const fail = (step: string, res: request.Response): never => {
  throw new Error(`${step} answered ${res.status.toString()}: ${JSON.stringify(res.body)}`);
};

/**
 * An AI connection made the way an app makes one: DCR registration, sign-in,
 * the organization picker, consent and the code exchange, all over HTTP.
 * Each call registers its own client, so every grant has a consent row of its own.
 */
export async function connectAiApp(args: {
  serverUrl: string;
  email: string;
  organizationId: string;
  scope?: string;
}): Promise<{ accessToken: string; clientId: string }> {
  const api = () => request(args.serverUrl);
  const post = (path: string, body: object, cookie?: string) => {
    const req = api().post(path).set("Origin", ORIGIN).set("Accept", "application/json");
    if (cookie) req.set("Cookie", cookie);
    return req.send(body);
  };

  const registered = await api()
    .post("/api/auth/oauth2/register")
    .send({
      client_name: "Test AI app",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  if (registered.status !== 201) fail("register", registered);
  const clientId = registered.body.client_id as string;

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: args.scope ?? "flexiday.read flexiday.write offline_access",
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: MCP_RESOURCE,
  });
  const authorized = await api().get(`/api/auth/oauth2/authorize?${query.toString()}`).redirects(0);
  if (authorized.status !== 302) fail("authorize", authorized);

  const signedIn = await post("/api/auth/sign-in/email", {
    email: args.email,
    password: WEB_TEST_PASSWORD,
    oauth_query: queryOf(authorized.headers.location as string),
  });
  if (signedIn.status !== 200) fail("sign-in", signedIn);
  const cookie = cookieHeaderOf(signedIn);

  const picked = await post(
    "/api/oauth-connect/organization",
    { organizationId: args.organizationId },
    cookie
  );
  if (picked.status !== 200) fail("pick", picked);
  const continued = await post(
    "/api/auth/oauth2/continue",
    { postLogin: true, oauth_query: queryOf(signedIn.body.url as string) },
    cookie
  );
  if (continued.status !== 200) fail("continue", continued);
  const consented = await post(
    "/api/auth/oauth2/consent",
    { accept: true, oauth_query: queryOf(continued.body.url as string) },
    cookie
  );
  if (consented.status !== 200) fail("consent", consented);

  const code = new URL(consented.body.url as string).searchParams.get("code") ?? "";
  const exchanged = await api().post("/api/auth/oauth2/token").type("form").send({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
    resource: MCP_RESOURCE,
  });
  if (exchanged.status !== 200) fail("token", exchanged);
  return { accessToken: exchanged.body.access_token as string, clientId };
}

/**
 * `requireMcpAuth` fetches the signing keys from the issuer's public URL,
 * which in e2e names port 8080 while the server listens on a loopback port.
 * Routes those fetches to the test server; every other fetch passes through.
 */
export function routePublicUrlTo(serverUrl: string): () => void {
  const original = globalThis.fetch;
  const routed: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(`${config.api.publicUrl}/`)) {
      return original(`${serverUrl}${url.slice(config.api.publicUrl.length)}`, init);
    }
    return original(input, init);
  };
  globalThis.fetch = routed;
  return () => {
    globalThis.fetch = original;
  };
}

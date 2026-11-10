import { Readable } from "node:stream";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { requireMcpAuth } from "@better-auth/mcp";
import {
  createMcpHandler,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import type { JWTPayload } from "jose";
import { config } from "../config.js";
import { loadMcpGrant } from "../services/aiConnections/mcpGrant.js";
import { ipKey, mcpUnauthBudget } from "../middleware/limiter.js";
import { auth } from "../utils/auth.js";
import { updateRequestContext } from "../utils/requestStore.js";
import { FLEXIDAY_READ, ORGANIZATION_CLAIM } from "../utils/aiConnectionsOAuth.js";
import { authInfoFor, createMcpServer, type McpPrincipal } from "./mcpServer.js";

export const MCP_RESOURCE = `${config.api.publicUrl}/mcp`;
const RESOURCE_METADATA = `${config.api.publicUrl}/.well-known/oauth-protected-resource/mcp`;

/** Browser origins allowed to call `/mcp`; requests without an `Origin` pass. */
const allowedOriginHostnames = [
  new URL(config.api.publicUrl).hostname,
  ...config.trustedOrigins
    .filter((origin) => /^https?:\/\//.test(origin))
    .map((origin) => new URL(origin).hostname),
  ...(config.api.env === "production" ? [] : localhostAllowedOrigins()),
];

const jsonRpcError = (status: number, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/** RFC 6750 `invalid_token`: the token verifies, but the grant behind it is gone. */
const invalidToken = () =>
  jsonRpcError(401, "The grant behind this token was revoked", {
    "WWW-Authenticate": `Bearer error="invalid_token", error_description="The grant was revoked", resource_metadata="${RESOURCE_METADATA}"`,
  });

// Stateless and built once: every request gets a fresh server from the factory,
// for either era (`legacy: 'stateless'` is the default).
const mcpHandler = createMcpHandler(({ authInfo }) => createMcpServer(authInfo), {
  responseMode: "json",
});

const tokenOf = (request: Request) =>
  (request.headers.get("authorization") ?? "").replace(/^(Bearer|DPoP)\s+/i, "");

const serveVerified = async (request: Request, claims: JWTPayload): Promise<Response> => {
  const organizationId = claims[ORGANIZATION_CLAIM];
  const clientId = claims.azp;
  if (!claims.sub || typeof clientId !== "string" || typeof organizationId !== "string") {
    return invalidToken();
  }
  const scopes = typeof claims.scope === "string" ? claims.scope.split(" ") : [];

  const grant = await loadMcpGrant({
    userId: claims.sub,
    clientId,
    organizationId,
    tokenScopes: scopes,
  });
  if (grant.status === "revoked") return invalidToken();
  if (grant.status === "unavailable") return jsonRpcError(404, "Not found");
  updateRequestContext({ userId: grant.user.id });

  const context = {
    auth: {
      sessionId: `mcp:${clientId}`,
      userId: grant.user.id,
      userName: grant.user.name,
      userEmail: grant.user.email,
      emailVerified: grant.user.emailVerified,
      channel: "mcp" as const,
    },
    organizationId,
    access: grant.status === "active" ? grant.access : ("read" as const),
    language: grant.user.language,
  };
  const principal: McpPrincipal =
    grant.status === "active"
      ? { status: "active", clientId, context }
      : { status: "refused", clientId, context, reason: grant.reason };

  return mcpHandler.fetch(request, {
    authInfo: authInfoFor(
      {
        token: tokenOf(request),
        clientId,
        scopes,
        ...(claims.exp ? { expiresAt: claims.exp } : {}),
        resource: new URL(MCP_RESOURCE),
      },
      principal
    ),
  });
};

/**
 * Verifies the access token against the issuer's keys (signature, issuer,
 * audience, expiry, `flexiday.read`), then settles the grant afresh: consent,
 * user, the organization's switch, setting and plan, and the user's standing.
 */
const protectedMcp = requireMcpAuth(auth, serveVerified, {
  resource: MCP_RESOURCE,
  requiredScopes: [FLEXIDAY_READ],
});

const toWebRequest = (req: ExpressRequest, signal: AbortSignal): Request => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  // The public URL, not the socket's: a DPoP proof is bound to the URL the client called.
  return new Request(`${config.api.publicUrl}${req.originalUrl}`, {
    method: req.method,
    headers,
    body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
    duplex: "half",
    signal,
  } as RequestInit);
};

const send = async (res: ExpressResponse, response: Response) => {
  res.status(response.status);
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (!response.body) {
    res.end();
    return;
  }
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    res.write(chunk);
  }
  res.end();
};

const tooManyRequests = (resetAt: Date) =>
  jsonRpcError(429, "Too many requests", {
    "Retry-After": String(Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000))),
  });

/** No token, a bad one, or a token whose grant is gone. */
const unauthenticated = (response: Response) => response.status === 401 || response.status === 403;

/**
 * `mcpUnauthBudget`: answers that fail authentication count per address. Once
 * spent, a request without a token is refused before any work, and one whose
 * token fails gets 429 instead of 401. A valid token is never refused here.
 */
const withinUnauthBudget = async (
  req: ExpressRequest,
  request: Request,
  serve: () => Promise<Response>
): Promise<Response> => {
  const address = ipKey(req);
  if (!tokenOf(request) && (await mcpUnauthBudget.spent(address))) {
    return tooManyRequests(await mcpUnauthBudget.resetAt(address));
  }
  const response = await serve();
  if (!unauthenticated(response)) return response;
  const hit = await mcpUnauthBudget.hit(address);
  return hit.allowed ? response : tooManyRequests(hit.resetAt);
};

/** `POST /mcp`: the Streamable HTTP endpoint, stateless, for both protocol eras. */
export const handleMcpPost = async (req: ExpressRequest, res: ExpressResponse) => {
  const aborted = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) aborted.abort();
  });
  const request = toWebRequest(req, aborted.signal);
  const response = await withinUnauthBudget(
    req,
    request,
    async () =>
      originValidationResponse(request, allowedOriginHostnames) ?? (await protectedMcp(request))
  );
  await send(res, response);
};

/** Any other method: the endpoint keeps no session to open a stream on or to end. */
export const handleMcpOtherMethod = (_req: ExpressRequest, res: ExpressResponse) => {
  res
    .status(405)
    .set("Allow", "POST")
    .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
};

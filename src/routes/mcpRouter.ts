import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { requireAiFeature } from "../middleware/aiFeatureGuard.js";
import { handleMcpOtherMethod, handleMcpPost } from "../mcp/mcpHttp.js";

export const mcpRouter = (): Router => {
  const app = Router();
  app.use(requireAiFeature("aiConnections", "public"));

  /**
   * @openapi
   * /mcp:
   *   post:
   *     tags:
   *       - AI connections
   *     summary: The Flexi Day MCP server (Streamable HTTP)
   *     description: |
   *       One JSON-RPC message per POST, stateless, for both protocol eras:
   *       2026-07-28 clients (`server/discover`, per-request `_meta`, the
   *       `MCP-Protocol-Version` header checked against the body) answered as
   *       plain JSON, and 2025-era clients (`initialize`) through the SDK's
   *       stateless fallback. Tools: `get_my_balances`, `list_my_requests`,
   *       `list_who_is_away`.
   *
   *       Every call verifies the OAuth access token (issuer
   *       `/api/auth`, audience this resource, scope `flexiday.read`), then
   *       loads the consent for the user, client and organization claim, the
   *       user, the organization's AI connections setting and plan, and the
   *       user's standing. A tool sees what the user sees in the app, inside
   *       the token's organization only.
   *
   *       A refusal that is not about the token (plan lapsed, standing lost,
   *       a guard's permission check) is a 200 with an `isError` tool result
   *       in the user's app language. A browser `Origin` outside the trusted
   *       origins is refused.
   *
   *       Limits on `tools/call`, answered the same way as an `isError` result
   *       naming the limit and its reset (`context.code`, `limit`, `resetsAt`):
   *       300 tool calls per 5 minutes and 30 write-tool calls per hour per user
   *       and OAuth client (`MCP_CALLS_PER_FIVE_MINUTES`, `MCP_WRITES_PER_HOUR`);
   *       the daily AI connection limit per organization and UTC day, Pro 5000,
   *       Enterprise and Custom 20000 (`DAILY_AI_CONNECTION_LIMIT`); the member
   *       daily limit, 1000 per member and organization and UTC day
   *       (`MEMBER_DAILY_LIMIT`). Other methods count toward none of them.
   *     operationId: handleMcpPost
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             description: A JSON-RPC 2.0 request or notification
   *     responses:
   *       '200':
   *         description: The JSON-RPC response (`text/event-stream` for some 2025-era exchanges)
   *       '202':
   *         description: A notification, accepted
   *       '401':
   *         description: |
   *           No token or a bad one (`WWW-Authenticate` with `resource_metadata` and
   *           `scope="flexiday.read flexiday.write"`, the scope clients then request),
   *           or `invalid_token`: the grant behind a valid token is gone (disconnected,
   *           user deleted, AI connections turned off)
   *       '403':
   *         description: The token lacks `flexiday.read` (`insufficient_scope`), or the `Origin` is not trusted
   *       '404':
   *         description: AI connections are unavailable for the token's organization, or everywhere
   *       '429':
   *         description: |
   *           2000 requests from this address failed authentication in 5 minutes;
   *           requests without a valid token are refused until `Retry-After` (seconds).
   *           A valid token is never refused this way.
   *         headers:
   *           Retry-After:
   *             schema:
   *               type: integer
   *   get:
   *     tags:
   *       - AI connections
   *     summary: Not supported
   *     description: The endpoint keeps no session, so there is no stream to open. DELETE answers the same.
   *     operationId: handleMcpOtherMethod
   *     security: []
   *     responses:
   *       '404':
   *         description: AI connections are unavailable
   *       '405':
   *         description: Method not allowed (`Allow: POST`)
   */
  app.post("/", tryCatch(handleMcpPost));
  app.all("/", handleMcpOtherMethod);

  return app;
};

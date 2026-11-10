import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { db } from "../db/db.js";
import { deleteUserGrants } from "../services/aiConnections/grants.js";

const changedUserId = (returned: unknown): string | undefined => {
  if (typeof returned !== "object" || returned === null || returned instanceof Error) return;
  const changed = (returned as { user?: { id?: unknown } }).user;
  return typeof changed?.id === "string" ? changed.id : undefined;
};

/**
 * A password change that signs out the other sessions ends every AI
 * connection too, once the change succeeded. Without `revokeOtherSessions`
 * the grants stay, like the sessions. Reset is `onPasswordReset`'s.
 */
export const aiConnectionGrantRevocation = {
  id: "ai-connection-grant-revocation",
  hooks: {
    after: [
      {
        matcher: (context) => context.path === "/change-password",
        handler: createAuthMiddleware(async (ctx) => {
          const body = (ctx.body ?? {}) as { revokeOtherSessions?: unknown };
          if (body.revokeOtherSessions !== true) return;
          const userId = changedUserId(ctx.context.returned);
          if (!userId) return;
          await deleteUserGrants(userId, db);
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;

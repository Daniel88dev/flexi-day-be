import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { decryptOAuthToken } from "better-auth/oauth2";
import { logger } from "../middleware/logger.js";
import {
  appleRevocationOf,
  revokeAtApple,
} from "../services/appleAuthorization/appleRevocation.js";
import type { AppleRevocation, StoredAppleLink } from "../services/appleAuthorization/types.js";
import type { AppleClient } from "./socialProviders.js";

type PendingRevocation = { userId: string; revocation: AppleRevocation };

type WithPendingRevocation = { pendingAppleRevocation?: PendingRevocation };

const isUnlink = (context: { path?: string }) => context.path === "/unlink-account";

const unlinked = (returned: unknown) =>
  typeof returned === "object" &&
  returned !== null &&
  (returned as { status?: unknown }).status === true;

/**
 * Revokes an Apple link at Apple when the user disconnects it in Settings. The
 * row is gone by the time the endpoint answers, so the before-hook reads its
 * token and audience and the after-hook revokes only once the unlink
 * succeeded, which also means the row was the caller's. Best effort: nothing
 * here changes what the unlink answers.
 */
export const appleUnlinkRevocation = (client: AppleClient | undefined) =>
  ({
    id: "apple-unlink-revocation",
    hooks: {
      before: [
        {
          matcher: isUnlink,
          handler: createAuthMiddleware(async (ctx) => {
            const accountId = (ctx.body as { accountId?: unknown } | undefined)?.accountId;
            if (!client || typeof accountId !== "string") return;
            try {
              const row = await ctx.context.adapter.findOne<
                StoredAppleLink & { providerId: string }
              >({ model: "account", where: [{ field: "id", value: accountId }] });
              if (row?.providerId !== "apple") return;

              const revocation = await appleRevocationOf(row, client.servicesId, (stored) =>
                decryptOAuthToken(stored, ctx.context)
              );
              const pending: WithPendingRevocation = {
                pendingAppleRevocation: { userId: row.userId, revocation },
              };
              return { context: pending };
            } catch (error) {
              logger.error("apple.revoke.collect_failed", {
                linkId: accountId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }),
        },
      ],
      after: [
        {
          matcher: isUnlink,
          handler: createAuthMiddleware(async (ctx) => {
            const pending = (ctx as WithPendingRevocation).pendingAppleRevocation;
            if (!client || !pending || !unlinked(ctx.context.returned)) return;
            await revokeAtApple(client, pending.userId, [pending.revocation]);
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;

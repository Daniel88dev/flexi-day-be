import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { parseUserOutput } from "better-auth/db";
import { z } from "zod";
import { consumeSignInTicket } from "../services/dev/signInTicketServices.js";
import { nativeClientOf } from "./nativeSession.js";

export const INVALID_SIGN_IN_TICKET = "INVALID_SIGN_IN_TICKET";

export const DEVICE_ID_REQUIRED = "DEVICE_ID_REQUIRED";

/**
 * Redeems a dev sign-in ticket for a native session. Registered only when
 * `config.dev` exists, and deliberately outside `devGuard`: see "Dev sign-in
 * ticket" in `docs/invariants.md`. The session goes through better-auth's own
 * creation so the native-session hooks bind it and evict the phone's previous
 * one exactly as they do after a password sign-in.
 */
export const devSignInTicketPlugin = {
  id: "dev-sign-in-ticket",
  endpoints: {
    redeemDevSignInTicket: createAuthEndpoint(
      "/dev/redeem-sign-in-ticket",
      {
        method: "POST",
        body: z.object({ ticket: z.string().min(1).max(256) }),
      },
      async (ctx) => {
        if (!nativeClientOf(ctx)) {
          throw new APIError("BAD_REQUEST", {
            message: "A dev sign-in ticket can only be redeemed by the phone app",
            code: DEVICE_ID_REQUIRED,
          });
        }

        const invalid = () =>
          new APIError("UNAUTHORIZED", {
            message: "Invalid or expired sign-in ticket",
            code: INVALID_SIGN_IN_TICKET,
          });

        const userId = consumeSignInTicket(ctx.body.ticket);
        if (!userId) throw invalid();

        const user = await ctx.context.internalAdapter.findUserById(userId);
        if (!user) throw invalid();

        const session = await ctx.context.internalAdapter.createSession(user.id);
        await setSessionCookie(ctx, { session, user });

        return ctx.json({
          token: session.token,
          user: parseUserOutput(ctx.context.options, user),
        });
      }
    ),
  },
} satisfies BetterAuthPlugin;

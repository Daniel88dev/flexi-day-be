import * as Sentry from "@sentry/node";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/db.js";
import { account as accountTable, user as userTable } from "../db/schema/auth-schema.js";
import { haveIBeenPwned, openAPI } from "better-auth/plugins";
import { config } from "../config.js";
import { emailSender } from "../services/email/index.js";
import { logger } from "../middleware/logger.js";
import { buildAccountLinking, buildSocialProviders } from "./socialProviders.js";

// better-auth's default verification-token expiry is 3600 s. Keep this string
// in sync if `emailVerification.expiresIn` is ever configured below.
const VERIFICATION_EXPIRES_IN = "1 hour";

// Likewise for `emailAndPassword.resetPasswordTokenExpiresIn`, which also
// defaults to 3600 s.
const RESET_EXPIRES_IN = "1 hour";

const socialProviders = buildSocialProviders(config?.auth);

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  socialProviders,
  account: { accountLinking: buildAccountLinking(socialProviders) },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    // Reset is the remediation for a stolen session, so it has to end the
    // stolen one. Without this a victim can change their password and the
    // attacker's cookie keeps working until it expires.
    revokeSessionsOnPasswordReset: true,
    // Completing a reset means clicking a link we mailed to the address, which
    // is the same proof the confirmation email asks for — so it settles the
    // address the same way. This is what makes a password usable at all for
    // someone who signed up through Google or Microsoft: social sign-in leaves
    // the address unverified on purpose, and `requireEmailVerification` above
    // would otherwise reject the password they just set, with no way to ask
    // for a confirmation email again.
    //
    // Promoting the row is only safe if nothing that predates the proof comes
    // along with it. An unverified account can have been created by a social
    // sign-in asserting an address its owner never confirmed — a directory
    // administrator can do exactly that — and social sign-in is not gated on
    // `requireEmailVerification`, so that provider link stays a way back in.
    // Left attached, the real owner's reset would hand the squatter a verified
    // account instead of taking it from them. The links are dropped with the
    // promotion, in one transaction; the owner reattaches whichever they want
    // from Settings, where being signed in is the thing that authorises it.
    onPasswordReset: async ({ user }, _request) => {
      if (user.emailVerified) return;
      try {
        await db.transaction(async (tx) => {
          await tx
            .delete(accountTable)
            .where(
              and(eq(accountTable.userId, user.id), ne(accountTable.providerId, "credential"))
            );
          await tx
            .update(userTable)
            .set({ emailVerified: true, updatedAt: new Date() })
            .where(eq(userTable.id, user.id));
        });
      } catch (error) {
        // The password change and the token are already spent upstream and
        // cannot be rolled back, so this leaves a user who cannot sign in with
        // the password they just set — and, on a squatted account, leaves the
        // squatter's provider link in place. Both halves need a person, so it
        // is reported as an exception rather than only written to the log.
        Sentry.captureException(error, {
          tags: { flow: "password-reset-settle" },
          extra: { userId: user.id },
        });
        logger.error("Failed to settle account after password reset", {
          userId: user.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    sendResetPassword: async ({ user, url }, _request) => {
      try {
        // `url` points at better-auth's own /reset-password/{token} endpoint,
        // which validates the token and then bounces to `callbackURL` with the
        // token attached. That parameter is whatever the client sent —
        // origin-checked by better-auth, but nothing pins it to the page that
        // can actually handle it, and a request that omitted it produces a
        // dead link. The destination of a link we mail out is ours to decide,
        // so it is set here, as the confirmation email does.
        const resetUrl = new URL(url);
        resetUrl.searchParams.set(
          "callbackURL",
          new URL("/reset-password/", config.email.appUrl).toString()
        );

        await emailSender.sendTemplated({
          to: user.email,
          template: "password-reset",
          data: {
            // A social sign-up whose provider profile carried no name is
            // stored with an empty one, and the SES adapter refuses a blank
            // variable. Falling back to the address keeps account recovery
            // working rather than failing it over a greeting.
            name: user.name?.trim() || user.email,
            resetUrl: resetUrl.toString(),
            expiresIn: RESET_EXPIRES_IN,
          },
        });
      } catch (error) {
        logger.error("Failed to send password reset email", {
          userId: user.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }, _request) => {
      try {
        const confirmationUrl = new URL(url);
        confirmationUrl.searchParams.set(
          "callbackURL",
          new URL("/email-verified/", config.email.appUrl).toString()
        );

        await emailSender.sendTemplated({
          to: user.email,
          template: "email-confirmation",
          data: {
            // Same reason as the reset mail below, and this is the path it
            // actually bites on: every social sign-up gets a confirmation
            // email, and Entra's `name` is an optional claim.
            name: user.name?.trim() || user.email,
            confirmationUrl: confirmationUrl.toString(),
            expiresIn: VERIFICATION_EXPIRES_IN,
          },
        });
      } catch (error) {
        logger.error("Failed to send verification email", {
          userId: user.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
  },
  rateLimit: {
    enabled: true,
    window: 10,
    max: 50,
  },
  trustedOrigins: config?.auth?.trustedOrigins ?? [],
  plugins: [haveIBeenPwned(), openAPI()],
});

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/db.js";
import { tempEmailSend } from "./tempEmail.js";
import { haveIBeenPwned, openAPI } from "better-auth/plugins";
import { config } from "../config.js";
import { emailSender } from "../services/email/index.js";
import { logger } from "../middleware/logger.js";

// better-auth's default verification-token expiry is 3600 s. Keep this string
// in sync if `emailVerification.expiresIn` is ever configured below.
const VERIFICATION_EXPIRES_IN = "1 hour";

// Register the Google provider only when both credentials are present, so
// non-production/test environments (and any deploy before the secrets are
// wired) start cleanly instead of failing with an empty client id/secret.
const socialProviders =
  config?.auth?.googleClientId && config?.auth?.googleClientSecret
    ? {
        google: {
          clientId: config.auth.googleClientId,
          clientSecret: config.auth.googleClientSecret,
        },
      }
    : undefined;

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  socialProviders,
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url, token }, _request) => {
      await tempEmailSend({
        to: user.email,
        subject: "Reset your password",
        text: `Click the link to verify your email: ${url}, token: ${token}`,
      });
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
            name: user.name,
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

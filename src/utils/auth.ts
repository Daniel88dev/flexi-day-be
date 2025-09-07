import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/db.js";
import { tempEmailSend } from "./tempEmail.js";
import { haveIBeenPwned, openAPI } from "better-auth/plugins";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
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
    sendVerificationEmail: async ({ user, url, token }, _request) => {
      await tempEmailSend({
        to: user.email,
        subject: "Verify your email address",
        text: `Click the link to verify your email: ${url}, token: ${token}`,
      });
    },
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
  },
  rateLimit: {
    enabled: true,
    window: 10,
    max: 5,
  },
  plugins: [haveIBeenPwned(), openAPI()],
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const sendTemplated = vi.fn();

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: (...args: unknown[]) => sendTemplated(...args) },
}));

import { auth } from "../../utils/auth.js";
import { config } from "../../config.js";
import { logger } from "../../middleware/logger.js";

const user = {
  id: "user-1",
  name: "Dana",
  email: "dana@example.com",
  emailVerified: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** better-auth hands the hook its own endpoint URL, not a frontend one. */
const RESET_URL =
  "http://localhost:8080/api/auth/reset-password/tok-123?callbackURL=http%3A%2F%2Fevil.example%2Fx";

function sendResetPassword(url = RESET_URL) {
  const send = auth.options.emailAndPassword?.sendResetPassword;
  if (!send) throw new Error("sendResetPassword is not configured");
  return send({ user, url, token: "tok-123" }, undefined);
}

describe("sendResetPassword", () => {
  beforeEach(() => {
    sendTemplated.mockReset().mockResolvedValue(undefined);
  });

  it("sends the password-reset template to the account's address", async () => {
    await sendResetPassword();

    expect(sendTemplated).toHaveBeenCalledTimes(1);
    const email = sendTemplated.mock.calls[0]?.[0] as {
      to: string;
      template: string;
      data: Record<string, string>;
    };
    expect(email.to).toBe("dana@example.com");
    expect(email.template).toBe("password-reset");
    expect(email.data.name).toBe("Dana");
    expect(email.data.expiresIn).toBeTruthy();
  });

  it("keeps better-auth's one-time token in the link", async () => {
    await sendResetPassword();

    const { resetUrl } = (sendTemplated.mock.calls[0]?.[0] as { data: { resetUrl: string } }).data;
    expect(new URL(resetUrl).pathname).toBe("/api/auth/reset-password/tok-123");
  });

  it("overwrites the caller's callbackURL with our own reset page", async () => {
    await sendResetPassword();

    // better-auth redirects the token to whatever the client asked for. Its
    // own originCheck already confines that to a trusted origin, so this is
    // the second lock rather than the only one — but it is what pins the link
    // to the right page, and the right spelling of it.
    const { resetUrl } = (sendTemplated.mock.calls[0]?.[0] as { data: { resetUrl: string } }).data;
    const callbackURL = new URL(resetUrl).searchParams.get("callbackURL") ?? "";
    expect(new URL(callbackURL).origin).toBe(new URL(config.email.appUrl).origin);
    // Trailing slash: the frontend is a static export and /reset-password is
    // only served at the directory path.
    expect(new URL(callbackURL).pathname).toBe("/reset-password/");
  });

  it("still produces a usable link when the request sent no callbackURL", async () => {
    await sendResetPassword("http://localhost:8080/api/auth/reset-password/tok-123?callbackURL=");

    const { resetUrl } = (sendTemplated.mock.calls[0]?.[0] as { data: { resetUrl: string } }).data;
    expect(new URL(resetUrl).searchParams.get("callbackURL")).toContain("/reset-password/");
  });

  it("greets a nameless social account by its address rather than failing", async () => {
    const send = auth.options.emailAndPassword?.sendResetPassword;
    if (!send) throw new Error("sendResetPassword is not configured");
    await send({ user: { ...user, name: "  " }, url: RESET_URL, token: "tok-123" }, undefined);

    // The SES adapter rejects a blank variable, and this hook swallows the
    // throw — so an empty name would black-hole account recovery silently.
    const email = sendTemplated.mock.calls[0]?.[0] as { data: { name: string } };
    expect(email.data.name).toBe("dana@example.com");
  });

  it("logs a failed send instead of throwing it back at the caller", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => logger);
    sendTemplated.mockRejectedValue(new Error("SES down"));

    // Throwing would turn a mail outage into a 500 on a route that otherwise
    // answers identically whether or not the address exists.
    await expect(sendResetPassword()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("password reset policy", () => {
  it("ends every other session", () => {
    // Reset is the remediation for a stolen session. Leaving the stolen one
    // alive means the victim's remediation achieves nothing.
    expect(auth.options.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true);
  });

  it("settles the address, so the new password is usable", () => {
    // `requireEmailVerification` rejects sign-in on an unverified account, and
    // social sign-up leaves the address unverified on purpose. Without this
    // hook a Google-only user sets a password they can never use, and there is
    // no resend-verification surface to escape with.
    expect(auth.options.emailAndPassword?.requireEmailVerification).toBe(true);
    expect(auth.options.emailAndPassword?.onPasswordReset).toBeTypeOf("function");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const sendTemplated = vi.fn();

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: (...args: unknown[]) => sendTemplated(...args) },
}));

import { auth } from "../../utils/auth.js";
import { logger } from "../../middleware/logger.js";

interface TwoFactorPluginShape {
  id: string;
  options?: {
    issuer?: string;
    skipVerificationOnEnable?: boolean;
    otpOptions?: {
      storeOTP?: string;
      sendOTP?: (
        data: { user: typeof user; otp: string },
        request: undefined
      ) => Promise<void> | void;
    };
  };
}

const user = {
  id: "user-1",
  name: "Dana",
  email: "dana@example.com",
  emailVerified: true,
  twoFactorEnabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function getPlugin(): NonNullable<TwoFactorPluginShape["options"]> {
  const plugin = (auth.options.plugins as TwoFactorPluginShape[]).find(
    (p) => p.id === "two-factor"
  );
  if (!plugin?.options) throw new Error("twoFactor plugin is not configured");
  return plugin.options;
}

function sendOTP(overrides: Partial<typeof user> = {}) {
  const send = getPlugin().otpOptions?.sendOTP;
  if (!send) throw new Error("sendOTP is not configured");
  return send({ user: { ...user, ...overrides }, otp: "042719" }, undefined);
}

describe("twoFactor sendOTP", () => {
  beforeEach(() => {
    sendTemplated.mockReset().mockResolvedValue(undefined);
  });

  it("sends the two-factor-code template to the account's address", async () => {
    await sendOTP();

    expect(sendTemplated).toHaveBeenCalledTimes(1);
    const email = sendTemplated.mock.calls[0]?.[0] as {
      to: string;
      template: string;
      data: Record<string, string>;
    };
    expect(email.to).toBe("dana@example.com");
    expect(email.template).toBe("two-factor-code");
    expect(email.data.name).toBe("Dana");
    expect(email.data.expiresIn).toBeTruthy();
  });

  it("passes the code as a string so a leading zero survives", async () => {
    await sendOTP();

    const { code } = (sendTemplated.mock.calls[0]?.[0] as { data: { code: string } }).data;
    expect(code).toBe("042719");
  });

  it("greets a nameless social account by its address rather than failing", async () => {
    // The SES adapter rejects a blank variable, and this hook swallows the
    // throw — an empty name would black-hole the sign-in code silently.
    await sendOTP({ name: "  " });

    const email = sendTemplated.mock.calls[0]?.[0] as { data: { name: string } };
    expect(email.data.name).toBe("dana@example.com");
  });

  it("logs a failed send instead of throwing it back at the caller", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => logger);
    sendTemplated.mockRejectedValue(new Error("SES down"));

    await expect(sendOTP()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("twoFactor policy", () => {
  it("labels the QR with the product, not the library", () => {
    expect(getPlugin().issuer).toBe("Flexi Day");
  });

  it("stores the emailed code hashed, not in cleartext", () => {
    // The default writes the plain code into the verification table.
    expect(getPlugin().otpOptions?.storeOTP).toBe("hashed");
  });

  it("requires a verified code before 2FA turns on", () => {
    // With skipVerificationOnEnable, a mistyped enable() would lock the user
    // out behind a factor they never proved they hold.
    expect(getPlugin().skipVerificationOnEnable).toBeUndefined();
  });
});

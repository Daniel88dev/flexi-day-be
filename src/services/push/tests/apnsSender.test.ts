import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApnsConfig } from "../../../config.js";
import { pushEnvironment } from "../../../db/schema/push-registration-schema.js";
import { newP256Key } from "../../../tests/appleFixtures.js";

const { logged } = vi.hoisted(() => ({ logged: [] as unknown[][] }));
vi.mock("../../../middleware/logger.js", () => ({
  logger: {
    info: (...args: unknown[]) => logged.push(args),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const APNS: ApnsConfig = {
  keyId: "KEY1234567",
  teamId: "TEAM123456",
  topic: "com.flexiday.app",
  privateKey: newP256Key().pem,
};

const senderUnder = async (env: "dev" | "production" | "test", apns?: ApnsConfig) => {
  vi.resetModules();
  vi.doMock("../../../config.js", () => ({ config: { api: { env }, apns } }));
  const [{ apnsSender }, { logApnsSender }] = await Promise.all([
    import("../index.js"),
    import("../logApnsSender.js"),
  ]);
  return { apnsSender, logApnsSender };
};

describe("apnsSender", () => {
  afterEach(() => {
    logged.length = 0;
    vi.doUnmock("../../../config.js");
  });

  it("is the log sender when no APNs config is set", async () => {
    const { apnsSender, logApnsSender } = await senderUnder("dev");
    expect(apnsSender).toBe(logApnsSender);
  });

  it("is the real sender when the APNs config is set", async () => {
    const { apnsSender, logApnsSender } = await senderUnder("production", APNS);
    expect(apnsSender).not.toBe(logApnsSender);
  });

  it("stays the log sender under test even with APNs config, so no test reaches Apple", async () => {
    const { apnsSender, logApnsSender } = await senderUnder("test", APNS);
    expect(apnsSender).toBe(logApnsSender);
  });

  it("logs the push and answers 200, never touching the token", async () => {
    const { logApnsSender } = await senderUnder("dev");
    const token = "ab".repeat(32);

    const answer = await logApnsSender.send({
      environment: pushEnvironment.Sandbox,
      token,
      payload: {
        aps: { alert: { title: "Title", body: "Body" }, badge: 1, sound: "default" },
        notificationId: "n-1",
        href: "/requests/",
      },
    });

    expect(answer).toEqual({ status: 200 });
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged)).toContain("n-1");
    expect(JSON.stringify(logged)).not.toContain(token);
  });
});

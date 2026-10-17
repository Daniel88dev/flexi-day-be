import { describe, it, expect } from "vitest";
import { validatePutPushRegistration } from "../types.js";

const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

describe("validatePutPushRegistration", () => {
  it.each(["sandbox", "production"])("accepts a hex token in %s", (environment) => {
    expect(validatePutPushRegistration.parse({ token: TOKEN, environment })).toEqual({
      token: TOKEN,
      environment,
    });
  });

  it("stores an upper-case token in lower case, so a dead-token match finds it", () => {
    expect(
      validatePutPushRegistration.parse({ token: TOKEN.toUpperCase(), environment: "sandbox" })
    ).toEqual({ token: TOKEN, environment: "sandbox" });
  });

  it.each([
    ["not hex", "z".repeat(64)],
    ["an odd number of digits", `${TOKEN}a`],
    ["too short for an APNs token", "ab".repeat(16)],
    ["too long", "ab".repeat(101)],
    ["empty", ""],
    ["spaced", `${TOKEN.slice(0, 32)} ${TOKEN.slice(32)}`],
    ["an Expo push token", "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"],
  ])("rejects a token that is %s", (_, token) => {
    const result = validatePutPushRegistration.safeParse({ token, environment: "sandbox" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("token");
  });

  it.each(["development", "Production", "", null])(
    "rejects %j as the environment",
    (environment) => {
      const result = validatePutPushRegistration.safeParse({ token: TOKEN, environment });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("environment");
    }
  );
});

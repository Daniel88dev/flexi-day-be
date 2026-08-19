import { describe, it, expect } from "vitest";
import { validatePostVacation } from "../types.js";

const base = {
  groupId: "550e8400-e29b-41d4-a716-446655440009",
  from: "2026-08-20",
  to: "2026-08-20",
};

describe("validatePostVacation", () => {
  it("accepts a better-auth-style (non-uuid) userId for on-behalf bookings", () => {
    // Real accounts carry 32-char alphanumeric ids; only seeded/e2e users are
    // uuids, so a uuid constraint here passes every test and fails production.
    const parsed = validatePostVacation.parse({
      ...base,
      userId: "QKcQTLPBHUwm2aNwZIDhD95xle3e37VD",
      autoApprove: true,
    });
    expect(parsed.userId).toBe("QKcQTLPBHUwm2aNwZIDhD95xle3e37VD");
    expect(parsed.autoApprove).toBe(true);
  });

  it("rejects autoApprove without a target userId", () => {
    expect(() => validatePostVacation.parse({ ...base, autoApprove: true })).toThrow();
  });

  it("defaults autoApprove to false", () => {
    expect(validatePostVacation.parse(base).autoApprove).toBe(false);
  });
});

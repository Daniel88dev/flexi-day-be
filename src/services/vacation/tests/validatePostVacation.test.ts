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
    const result = validatePostVacation.safeParse({ ...base, autoApprove: true });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("autoApprove");
  });

  it("defaults autoApprove to false", () => {
    expect(validatePostVacation.parse(base).autoApprove).toBe(false);
  });

  it("rejects an OTHER request without a note", () => {
    const result = validatePostVacation.safeParse({ ...base, vacationType: "OTHER" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("note");
  });

  it("rejects an OTHER request whose note is only whitespace", () => {
    const result = validatePostVacation.safeParse({
      ...base,
      vacationType: "OTHER",
      note: "   ",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("note");
  });

  it("accepts an OTHER request that carries a note", () => {
    const parsed = validatePostVacation.parse({
      ...base,
      vacationType: "OTHER",
      note: "Jury duty",
    });
    expect(parsed.vacationType).toBe("OTHER");
    expect(parsed.note).toBe("Jury duty");
  });

  it("keeps the note optional for every other type", () => {
    for (const vacationType of ["VACATION", "STUDY_LEAVE", "NON_PAID_LEAVE"]) {
      expect(validatePostVacation.safeParse({ ...base, vacationType }).success).toBe(true);
    }
  });
});

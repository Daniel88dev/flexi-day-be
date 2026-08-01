import { describe, it, expect } from "vitest";
import { generateInviteCode, normalizeInviteCode } from "../../utils/inviteCode.js";

describe("generateInviteCode", () => {
  it("produces a XXXX-XXXX-XXXX code", () => {
    expect(generateInviteCode()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it("never emits the characters that are ambiguous when read aloud", () => {
    const codes = Array.from({ length: 200 }, () => generateInviteCode()).join("");
    for (const ambiguous of ["I", "L", "O", "U", "0", "1"]) {
      expect(codes).not.toContain(ambiguous);
    }
  });

  it("does not repeat itself across a large batch", () => {
    const codes = Array.from({ length: 1000 }, () => generateInviteCode());
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("round-trips through normalizeInviteCode unchanged", () => {
    const code = generateInviteCode();
    expect(normalizeInviteCode(code)).toBe(code);
  });
});

describe("normalizeInviteCode", () => {
  it("accepts the canonical form", () => {
    expect(normalizeInviteCode("ABCD-EFGH-JKMN")).toBe("ABCD-EFGH-JKMN");
  });

  it("accepts lower case", () => {
    expect(normalizeInviteCode("abcd-efgh-jkmn")).toBe("ABCD-EFGH-JKMN");
  });

  it("accepts a code with no dashes", () => {
    expect(normalizeInviteCode("ABCDEFGHJKMN")).toBe("ABCD-EFGH-JKMN");
  });

  it("accepts stray whitespace from a copy-paste", () => {
    expect(normalizeInviteCode("  ABCD EFGH JKMN ")).toBe("ABCD-EFGH-JKMN");
  });

  it("rejects a code of the wrong length", () => {
    expect(normalizeInviteCode("ABCD-EFGH")).toBeNull();
    expect(normalizeInviteCode("ABCD-EFGH-JKMN-PQRS")).toBeNull();
  });

  it("rejects characters outside the alphabet", () => {
    // O and 0 are deliberately absent, so a typo cannot silently resolve to
    // some other valid code.
    expect(normalizeInviteCode("ABCD-EFGH-JKM0")).toBeNull();
    expect(normalizeInviteCode("ABCD-EFGH-JKM!")).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(normalizeInviteCode("")).toBeNull();
  });
});

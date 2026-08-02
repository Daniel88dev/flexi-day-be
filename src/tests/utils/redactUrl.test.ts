/**
 * Unit tests for URL redaction used by the request log.
 * Test library/framework: Vitest
 */
import { describe, it, expect } from "vitest";
import { redactPath, redactQuery } from "../../utils/redactUrl.js";

describe("redactPath", () => {
  it("strips the calendar feed token, which authenticates the whole feed", () => {
    expect(redactPath("/calendars/9f3a1c7e5b2d4a8f6c0e1b3d5a7f9c2e.ics")).toBe(
      "/calendars/:token.ics"
    );
  });

  it("leaves ordinary paths untouched", () => {
    expect(redactPath("/api/vacation/123")).toBe("/api/vacation/123");
    expect(redactPath("/health")).toBe("/health");
  });

  it("does not match a path that merely starts with /calendars", () => {
    expect(redactPath("/calendars")).toBe("/calendars");
    expect(redactPath("/calendars/a/b.ics")).toBe("/calendars/a/b.ics");
  });
});

describe("redactQuery", () => {
  it("returns undefined when there is no query string", () => {
    expect(redactQuery({})).toBeUndefined();
    expect(redactQuery(undefined as never)).toBeUndefined();
  });

  it("keeps ordinary parameters — they are the point of logging the query", () => {
    expect(redactQuery({ year: "2026", month: "8" })).toBe("year=2026&month=8");
  });

  it.each(["token", "code", "secret", "password", "key", "email"])(
    "redacts the value of %s",
    (param) => {
      const result = redactQuery({ [param]: "s3cret-value" });
      expect(result).toBe(`${param}=[redacted]`);
      expect(result).not.toContain("s3cret");
    }
  );

  it("redacts regardless of casing", () => {
    expect(redactQuery({ Token: "abc" })).toBe("Token=[redacted]");
  });

  it("joins repeated parameters into one scalar", () => {
    expect(redactQuery({ id: ["a", "b"] })).toBe("id=a,b");
  });

  it("records the shape of nested object syntax rather than its contents", () => {
    expect(redactQuery({ filter: { name: "x" } as never })).toBe("filter=[object]");
  });

  it("redacts one parameter without dropping its neighbours", () => {
    expect(redactQuery({ year: "2026", token: "abc" })).toBe("year=2026&token=[redacted]");
  });
});

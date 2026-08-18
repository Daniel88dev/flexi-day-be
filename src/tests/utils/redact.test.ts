/**
 * Unit tests for redaction of logged URLs and error context.
 * Test library/framework: Vitest
 */
import { describe, it, expect } from "vitest";
import { redactMethod, redactPath, redactQuery, redactObject } from "../../utils/redact.js";

describe("redactPath", () => {
  it("strips the calendar feed token, which authenticates the whole feed", () => {
    expect(redactPath("/calendars/9f3a1c7e5b2d4a8f6c0e1b3d5a7f9c2e.ics")).toBe(
      "/calendars/:token.ics"
    );
  });

  it("strips the password-reset token, which better-auth puts in the path", () => {
    // Query redaction cannot reach this one, and the GET behind it does not
    // consume the token — so a leaked log line is a live account takeover for
    // the rest of the hour.
    expect(redactPath("/api/auth/reset-password/qX9kR2mTn7pL4vB8")).toBe(
      "/api/auth/reset-password/:token"
    );
  });

  it("keeps redacting the reset token when the token holds control characters", () => {
    expect(redactPath("/api/auth/reset-password/qX9k\r\ninfo: forged")).toBe(
      "/api/auth/reset-password/:token"
    );
  });

  it.each([
    [
      "a trailing slash",
      "/api/auth/reset-password/qX9kR2mTn7pL4vB8/",
      "/api/auth/reset-password/:token/",
    ],
    [
      "a repeated segment",
      "/api/auth/reset-password/first/reset-password/second",
      "/api/auth/reset-password/:token/reset-password/:token",
    ],
  ])("hides the reset token despite %s", (_case, path, expected) => {
    // This runs before routing, so it sees paths no route matches — and an
    // unmatched request is logged just the same, token and all.
    expect(redactPath(path)).toBe(expected);
  });

  it("hides the calendar token despite a trailing slash", () => {
    expect(redactPath("/calendars/9f3a1c7e5b2d4a8f.ics/")).toBe("/calendars/:token.ics/");
  });

  it.each([
    ["/calendars/9f3a1c7e5b2d4a8f.ICS", "/calendars/:token.ics"],
    ["/CALENDARS/9f3a1c7e5b2d4a8f.ics", "/calendars/:token.ics"],
    ["/api/auth/Reset-Password/qX9kR2mTn7pL4vB8", "/api/auth/reset-password/:token"],
  ])("hides %s, which Express routes all the same", (path, expected) => {
    // Express matches routes case-insensitively, so an uppercase spelling is
    // served normally — and the feed token behind it never expires.
    expect(redactPath(path)).toBe(expected);
  });

  it("leaves the reset endpoint that carries no token alone", () => {
    // POST /reset-password takes the token in the body, so there is nothing
    // in the path to hide and the route name stays readable in logs.
    expect(redactPath("/api/auth/reset-password")).toBe("/api/auth/reset-password");
  });

  it("leaves ordinary paths untouched", () => {
    expect(redactPath("/api/vacation/123")).toBe("/api/vacation/123");
    expect(redactPath("/health")).toBe("/health");
  });

  it("does not match a path that merely starts with /calendars", () => {
    expect(redactPath("/calendars")).toBe("/calendars");
    expect(redactPath("/calendars/a/b.ics")).toBe("/calendars/a/b.ics");
  });

  it("strips control characters, so a path cannot forge a log line", () => {
    expect(redactPath("/api/x\r\ninfo: forged")).toBe("/api/xinfo: forged");
    expect(redactPath("/api/\u0000\u001f\u007fx")).toBe("/api/x");
  });
});

describe("redactMethod", () => {
  it("leaves a real method untouched", () => {
    expect(redactMethod("GET")).toBe("GET");
  });

  it("strips control characters", () => {
    expect(redactMethod("GET\r\ninfo: forged")).toBe("GETinfo: forged");
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

describe("redactQuery value sanitisation", () => {
  it("escapes delimiters so a value cannot read as extra parameters", () => {
    expect(redactQuery({ name: "a&admin=true" })).toBe("name=a%26admin%3Dtrue");
  });

  it("strips control characters that could forge a second log line", () => {
    expect(redactQuery({ name: "one\ntwo\r" })).toBe("name=onetwo");
  });

  it("sanitises inside repeated parameters too", () => {
    expect(redactQuery({ id: ["a&b", "c"] })).toBe("id=a%26b,c");
  });

  it("caps an oversized query so one request cannot flood the logs", () => {
    const result = redactQuery({ q: "x".repeat(5000) });
    expect(result?.length).toBeLessThanOrEqual(513);
    expect(result?.endsWith("…")).toBe(true);
  });
});

describe("redactObject", () => {
  it("redacts a token left in AppError context", () => {
    expect(redactObject({ token: "super-secret-feed-token" })).toEqual({ token: "[redacted]" });
  });

  it("redacts the emails the sign-up and invite paths put in AppError context", () => {
    expect(redactObject({ invitedEmail: "a@b.com", email: "c@d.com" })).toEqual({
      invitedEmail: "[redacted]",
      email: "[redacted]",
    });
  });

  it("keeps the context that makes an error investigable", () => {
    expect(redactObject({ userId: "u1", groupId: "g1", url: "/api/group" })).toEqual({
      userId: "u1",
      groupId: "g1",
      url: "/api/group",
    });
  });

  it("reaches nested objects and arrays", () => {
    expect(redactObject({ errors: [{ context: { email: "a@b.com", userId: "u1" } }] })).toEqual({
      errors: [{ context: { email: "[redacted]", userId: "u1" } }],
    });
  });

  it("stops at a depth limit rather than walking forever", () => {
    const deep = { a: { b: { c: { d: { e: { f: "too far" } } } } } };
    expect(JSON.stringify(redactObject(deep))).toContain("[depth]");
  });

  it("passes scalars through untouched", () => {
    expect(redactObject("plain")).toBe("plain");
    expect(redactObject(42)).toBe(42);
    expect(redactObject(null)).toBe(null);
  });
});

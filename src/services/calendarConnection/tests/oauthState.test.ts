import { describe, it, expect } from "vitest";
import {
  CALENDAR_SYNC_STATE_INVALID,
  OAUTH_STATE_TTL_MS,
  signOAuthState,
  verifyOAuthState,
} from "../oauthState.js";
import { calendarProvider } from "../../../db/schema/calendar-connection-schema.js";
import AppError from "../../../utils/appError.js";
import { tamper } from "./tamperState.js";

const SECRET = "better-auth-secret-for-tests";
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

const INPUT = {
  userId: "e9dl7v5efgnn0cjrmn7hqz3aswwqxg2b",
  configId: "6c1f8a52-9d3e-4b7a-8f21-3e5d7c9a1b40",
  timeZone: "Europe/Prague",
  provider: calendarProvider.Google,
};

const rejection = (fn: () => unknown): AppError => {
  try {
    fn();
  } catch (error) {
    return error as AppError;
  }
  throw new Error("expected a rejection");
};

const expectInvalid = (fn: () => unknown) => {
  const error = rejection(fn);
  expect(error).toBeInstanceOf(AppError);
  expect(error.statusCode).toBe(400);
  expect(error.errors[0]?.publicContext).toEqual({ code: CALENDAR_SYNC_STATE_INVALID });
};

describe("calendar OAuth state", () => {
  it("round-trips the user, config, zone and provider", () => {
    const state = signOAuthState(INPUT, SECRET, NOW);

    const payload = verifyOAuthState(state, calendarProvider.Google, SECRET, NOW + 60_000);

    expect(payload).toMatchObject(INPUT);
  });

  it("carries a fresh nonce each time", () => {
    expect(signOAuthState(INPUT, SECRET, NOW)).not.toBe(signOAuthState(INPUT, SECRET, NOW));
  });

  it("is URL safe", () => {
    expect(signOAuthState(INPUT, SECRET, NOW)).toMatch(/^[A-Za-z0-9_.-]+$/);
  });

  it("expires after ten minutes", () => {
    const state = signOAuthState(INPUT, SECRET, NOW);

    expect(() =>
      verifyOAuthState(state, calendarProvider.Google, SECRET, NOW + OAUTH_STATE_TTL_MS - 1)
    ).not.toThrow();
    expectInvalid(() =>
      verifyOAuthState(state, calendarProvider.Google, SECRET, NOW + OAUTH_STATE_TTL_MS + 1)
    );
    expect(OAUTH_STATE_TTL_MS).toBe(10 * 60 * 1000);
  });

  it("rejects a payload rewritten to another user", () => {
    const state = signOAuthState(INPUT, SECRET, NOW);
    const [encoded, signature] = state.split(".");
    const payload = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8"));
    const forged = Buffer.from(JSON.stringify({ ...payload, userId: "attacker" })).toString(
      "base64url"
    );

    expectInvalid(() =>
      verifyOAuthState(`${forged}.${signature}`, calendarProvider.Google, SECRET, NOW)
    );
  });

  it("rejects a tampered signature", () => {
    expectInvalid(() =>
      verifyOAuthState(
        tamper(signOAuthState(INPUT, SECRET, NOW)),
        calendarProvider.Google,
        SECRET,
        NOW
      )
    );
  });

  it("rejects a state signed with another key", () => {
    const state = signOAuthState(INPUT, "another-secret", NOW);

    expectInvalid(() => verifyOAuthState(state, calendarProvider.Google, SECRET, NOW));
  });

  it("rejects a state minted for the other provider", () => {
    const state = signOAuthState(INPUT, SECRET, NOW);

    expectInvalid(() => verifyOAuthState(state, calendarProvider.Microsoft, SECRET, NOW));
  });

  it("rejects garbage", () => {
    for (const state of ["", "no-dot", "a.b.c", "%%%.###", "x".repeat(5000)]) {
      expectInvalid(() => verifyOAuthState(state, calendarProvider.Google, SECRET, NOW));
    }
  });

  it("rejects a missing state", () => {
    expectInvalid(() => verifyOAuthState(undefined, calendarProvider.Google, SECRET, NOW));
  });
});

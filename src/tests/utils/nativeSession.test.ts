import { describe, it, expect } from "vitest";
import { APIError } from "better-auth/api";
import {
  NATIVE_SESSION_TTL,
  NATIVE_SESSION_TTL_MS,
  SESSION_DEVICE_MISMATCH,
  deviceMismatchError,
  isDeviceMismatch,
  isDeviceMismatchError,
  nativeClientOf,
  nativeSessionExpiresAt,
  nativeSessionStamp,
} from "../../utils/nativeSession.js";

const DEVICE_ID = "6f1b3c2e-1d4a-4b7e-9c2f-0a1b2c3d4e5f";

const nativeHeaders = (extra: Record<string, string> = {}) =>
  new Headers({ "x-client-device-id": DEVICE_ID, ...extra });

describe("the ten-year lifetime", () => {
  it("is ten years", () => {
    expect(NATIVE_SESSION_TTL).toBe(315360000);
    expect(NATIVE_SESSION_TTL / (365 * 24 * 60 * 60)).toBe(10);
  });

  it("derives the row's milliseconds from the cookie's seconds", () => {
    // The whole point of the single constant: one value, two units.
    expect(NATIVE_SESSION_TTL_MS).toBe(NATIVE_SESSION_TTL * 1000);
  });

  it("puts the expiry a whole lifetime past the moment it is asked for", () => {
    const now = new Date("2026-09-19T08:30:00.000Z");

    expect(nativeSessionExpiresAt(now).getTime() - now.getTime()).toBe(NATIVE_SESSION_TTL * 1000);
  });

  it("measures from now when no moment is given", () => {
    const before = Date.now();
    const expiry = nativeSessionExpiresAt().getTime();

    expect(expiry).toBeGreaterThanOrEqual(before + NATIVE_SESSION_TTL_MS);
    expect(expiry).toBeLessThanOrEqual(Date.now() + NATIVE_SESSION_TTL_MS);
  });
});

describe("nativeClientOf", () => {
  it("reads the headers a hook context carries directly", () => {
    expect(nativeClientOf({ headers: nativeHeaders() })?.deviceId).toBe(DEVICE_ID);
  });

  it("falls back to the headers on the request the context was built from", () => {
    expect(nativeClientOf({ request: { headers: nativeHeaders() } })?.deviceId).toBe(DEVICE_ID);
  });

  it("answers null for a context with no request in flight", () => {
    expect(nativeClientOf(null)).toBeNull();
    expect(nativeClientOf(undefined)).toBeNull();
    expect(nativeClientOf({})).toBeNull();
  });

  it("answers null for a browser request, and for a malformed device id", () => {
    expect(nativeClientOf({ headers: new Headers() })).toBeNull();
    expect(nativeClientOf({ headers: new Headers({ "x-client-device-id": "short" }) })).toBeNull();
  });
});

describe("nativeSessionStamp", () => {
  const now = new Date("2026-09-19T08:30:00.000Z");

  it("stamps the three columns and the expiry for a native request", () => {
    const stamp = nativeSessionStamp(
      {
        headers: nativeHeaders({
          "x-client-platform": "ios",
          "x-client-app-version": "1.0.0+12",
        }),
      },
      now
    );

    expect(stamp).toEqual({
      deviceId: DEVICE_ID,
      platform: "ios",
      appVersion: "1.0.0+12",
      expiresAt: nativeSessionExpiresAt(now),
    });
  });

  it("leaves a malformed platform or app version null and still stamps", () => {
    const stamp = nativeSessionStamp(
      {
        headers: nativeHeaders({
          "x-client-platform": "windows-phone",
          "x-client-app-version": "1.0.0 (drop table user)",
        }),
      },
      now
    );

    expect(stamp).toMatchObject({ deviceId: DEVICE_ID, platform: null, appVersion: null });
  });

  it("leaves a web request alone, so better-auth's seven days stand", () => {
    expect(nativeSessionStamp({ headers: new Headers() }, now)).toBeNull();
    expect(nativeSessionStamp(null, now)).toBeNull();
  });
});

describe("the device check", () => {
  const OTHER_DEVICE_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

  it("lets a bound session through from the phone that opened it", () => {
    expect(isDeviceMismatch(DEVICE_ID, DEVICE_ID)).toBe(false);
  });

  it("catches a bound session called from another device", () => {
    expect(isDeviceMismatch(DEVICE_ID, OTHER_DEVICE_ID)).toBe(true);
  });

  it("catches a bound session called with no device id at all", () => {
    // Which is also what a malformed header looks like: `readNativeClient`
    // drops it rather than half-accepting it.
    expect(isDeviceMismatch(DEVICE_ID, null)).toBe(true);
    expect(isDeviceMismatch(DEVICE_ID, undefined)).toBe(true);
  });

  it("ignores the header entirely on an unbound session", () => {
    expect(isDeviceMismatch(null, DEVICE_ID)).toBe(false);
    expect(isDeviceMismatch(null, null)).toBe(false);
    expect(isDeviceMismatch(undefined, OTHER_DEVICE_ID)).toBe(false);
  });

  it("carries the code the phone keys its wipe on", () => {
    const error = deviceMismatchError();

    expect(error.statusCode).toBe(401);
    expect(error.body).toMatchObject({ code: SESSION_DEVICE_MISMATCH });
  });

  it("recognises its own error and nothing else", () => {
    expect(isDeviceMismatchError(deviceMismatchError())).toBe(true);
    expect(isDeviceMismatchError(new APIError("UNAUTHORIZED", { message: "nope" }))).toBe(false);
    expect(isDeviceMismatchError(new Error(SESSION_DEVICE_MISMATCH))).toBe(false);
    expect(isDeviceMismatchError(null)).toBe(false);
  });
});

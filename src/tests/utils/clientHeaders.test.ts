import { describe, it, expect } from "vitest";
import {
  CLIENT_HEADERS,
  acceptClientAppVersion,
  acceptClientDeviceId,
  acceptClientPlatform,
  acceptClientSessionId,
  readNativeClient,
} from "../../utils/clientHeaders.js";

const UUID = "6f1b3c2e-1d4a-4b7e-9c2f-0a1b2c3d4e5f";
// What an App Attest key id looks like: 32 bytes, base64, padded.
const BASE64_KEY_ID = "S3ZXHSMlXqZrkZSF0Zl0z1wfcpbCJoGPjM4aEo5cEcs=";

const headers = (values: Record<string, string>) => new Headers(values);

describe("acceptClientSessionId", () => {
  it("keeps a UUID", () => {
    expect(acceptClientSessionId(UUID)).toBe(UUID);
  });

  it("refuses anything that is not a UUID, including a device id shape", () => {
    expect(acceptClientSessionId(BASE64_KEY_ID)).toBeUndefined();
    expect(acceptClientSessionId("'; DROP TABLE user; --")).toBeUndefined();
    expect(acceptClientSessionId(undefined)).toBeUndefined();
  });
});

describe("acceptClientDeviceId", () => {
  it("accepts a 44-character base64 value and a UUID", () => {
    expect(BASE64_KEY_ID).toHaveLength(44);
    expect(acceptClientDeviceId(BASE64_KEY_ID)).toBe(BASE64_KEY_ID);
    expect(acceptClientDeviceId(UUID)).toBe(UUID);
  });

  it("accepts the shortest and longest allowed values", () => {
    expect(acceptClientDeviceId("a".repeat(8))).toHaveLength(8);
    expect(acceptClientDeviceId("a".repeat(128))).toHaveLength(128);
  });

  it("refuses anything shorter than 8 or longer than 128 characters", () => {
    expect(acceptClientDeviceId("a".repeat(7))).toBeUndefined();
    expect(acceptClientDeviceId("a".repeat(129))).toBeUndefined();
  });

  it("refuses characters outside the allowed alphabet", () => {
    expect(acceptClientDeviceId("device id with spaces")).toBeUndefined();
    expect(acceptClientDeviceId("device\nid\nwith\nnewlines")).toBeUndefined();
    expect(acceptClientDeviceId("<script>alert(1)</script>")).toBeUndefined();
    expect(acceptClientDeviceId(undefined)).toBeUndefined();
  });
});

describe("acceptClientPlatform", () => {
  it("accepts only ios and android", () => {
    expect(acceptClientPlatform("ios")).toBe("ios");
    expect(acceptClientPlatform("android")).toBe("android");
  });

  it("refuses any other value, including a different case", () => {
    expect(acceptClientPlatform("iOS")).toBeUndefined();
    expect(acceptClientPlatform("web")).toBeUndefined();
    expect(acceptClientPlatform("")).toBeUndefined();
    expect(acceptClientPlatform(undefined)).toBeUndefined();
  });
});

describe("acceptClientAppVersion", () => {
  it("accepts a semver with a build number", () => {
    expect(acceptClientAppVersion("1.0.0+12")).toBe("1.0.0+12");
    expect(acceptClientAppVersion("2.3.4-beta.1")).toBe("2.3.4-beta.1");
  });

  it("refuses an empty, over-long or oddly punctuated value", () => {
    expect(acceptClientAppVersion("")).toBeUndefined();
    expect(acceptClientAppVersion("1".repeat(33))).toBeUndefined();
    expect(acceptClientAppVersion("1.0.0 (12)")).toBeUndefined();
    expect(acceptClientAppVersion(undefined)).toBeUndefined();
  });
});

describe("readNativeClient", () => {
  it("returns the triple for a valid device id", () => {
    expect(
      readNativeClient(
        headers({
          [CLIENT_HEADERS.deviceId]: BASE64_KEY_ID,
          [CLIENT_HEADERS.platform]: "ios",
          [CLIENT_HEADERS.appVersion]: "1.0.0+12",
        })
      )
    ).toEqual({ deviceId: BASE64_KEY_ID, platform: "ios", appVersion: "1.0.0+12" });
  });

  it("returns null when the device id is missing or malformed", () => {
    expect(readNativeClient(headers({}))).toBeNull();
    expect(readNativeClient(headers({ [CLIENT_HEADERS.deviceId]: "short" }))).toBeNull();
    expect(readNativeClient(undefined)).toBeNull();
  });

  it("still returns null when only platform and app version arrive", () => {
    expect(
      readNativeClient(
        headers({ [CLIENT_HEADERS.platform]: "ios", [CLIENT_HEADERS.appVersion]: "1.0.0" })
      )
    ).toBeNull();
  });

  it("leaves platform or app version null on their own when only they are malformed", () => {
    expect(
      readNativeClient(
        headers({
          [CLIENT_HEADERS.deviceId]: BASE64_KEY_ID,
          [CLIENT_HEADERS.platform]: "windows-phone",
          [CLIENT_HEADERS.appVersion]: "1.0.0+12",
        })
      )
    ).toEqual({ deviceId: BASE64_KEY_ID, platform: null, appVersion: "1.0.0+12" });

    expect(
      readNativeClient(
        headers({
          [CLIENT_HEADERS.deviceId]: BASE64_KEY_ID,
          [CLIENT_HEADERS.platform]: "android",
          [CLIENT_HEADERS.appVersion]: "x".repeat(200),
        })
      )
    ).toEqual({ deviceId: BASE64_KEY_ID, platform: "android", appVersion: null });
  });

  it("drops a malformed value whole rather than truncating it", () => {
    const client = readNativeClient(
      headers({
        [CLIENT_HEADERS.deviceId]: BASE64_KEY_ID,
        [CLIENT_HEADERS.appVersion]: "9".repeat(200),
      })
    );

    expect(client?.appVersion).toBeNull();
    expect(JSON.stringify(client)).not.toContain("999");
  });

  it("reads headers case-insensitively, as better-auth hands them over", () => {
    expect(readNativeClient(headers({ "X-Client-Device-Id": UUID }))?.deviceId).toBe(UUID);
  });
});

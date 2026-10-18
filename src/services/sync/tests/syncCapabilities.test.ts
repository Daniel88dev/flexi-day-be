import { describe, expect, it } from "vitest";
import { readSyncCapabilities } from "../syncCapabilities.js";

describe("readSyncCapabilities", () => {
  it("accepts AWAY when the header names the token", () => {
    expect(readSyncCapabilities("away")).toEqual({ acceptsAway: true });
  });

  it("reads the token from a comma-separated list, case-insensitively", () => {
    expect(readSyncCapabilities("future-thing, AWAY ,other")).toEqual({ acceptsAway: true });
  });

  it("refuses AWAY without the header", () => {
    expect(readSyncCapabilities(undefined)).toEqual({ acceptsAway: false });
  });

  it("refuses AWAY for a header naming other tokens or a token that only contains it", () => {
    expect(readSyncCapabilities("")).toEqual({ acceptsAway: false });
    expect(readSyncCapabilities("awayish, not-away")).toEqual({ acceptsAway: false });
  });
});

import { describe, expect, it } from "vitest";
import { requirePathParam } from "../pathParams.js";

describe("requirePathParam", () => {
  it("returns a present single value", () => {
    expect(requirePathParam("abc", "session id")).toBe("abc");
  });

  it.each([undefined, ""])("rejects a missing value (%j) with 422", (value) => {
    expect(() => requirePathParam(value, "session id")).toThrow(
      expect.objectContaining({ code: 422, message: "A session id is required" })
    );
  });

  it("rejects a wildcard segment list with 422", () => {
    expect(() => requirePathParam(["a", "b"], "session id")).toThrow(
      expect.objectContaining({ code: 422, message: "A session id is required" })
    );
  });
});

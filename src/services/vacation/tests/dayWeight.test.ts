import { describe, it, expect } from "vitest";
import { dayWeightOf } from "../dayWeight.js";

describe("dayWeightOf", () => {
  it("counts a half day as 0.5", () => {
    expect(dayWeightOf({ halfDay: true })).toBe(0.5);
  });

  it("counts a full day as 1", () => {
    expect(dayWeightOf({ halfDay: false })).toBe(1);
  });
});

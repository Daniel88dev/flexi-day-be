import { describe, it, expect, vi } from "vitest";

// The helper is pure, but it lives in a module that also wires up the DB pool.
// Stub the DB import so pulling in the module never touches config/Postgres.
vi.mock("../../../db/db.js", () => ({ db: {} }));

import { contiguousRunContaining } from "../vacationServices.js";

const row = (id: string, requestedDay: string) => ({ id, requestedDay });

describe("contiguousRunContaining", () => {
  it("returns the whole run when every day is contiguous", () => {
    const rows = [row("a", "2026-08-10"), row("b", "2026-08-11"), row("c", "2026-08-12")];
    expect(contiguousRunContaining(rows, "2026-08-11").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("trims to the run containing the target when there is a gap", () => {
    // 10-11 are one run, 13-14 another (12 missing). Target 13 → only 13-14.
    const rows = [
      row("a", "2026-08-10"),
      row("b", "2026-08-11"),
      row("c", "2026-08-13"),
      row("d", "2026-08-14"),
    ];
    expect(contiguousRunContaining(rows, "2026-08-13").map((r) => r.id)).toEqual(["c", "d"]);
    expect(contiguousRunContaining(rows, "2026-08-10").map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("sorts unordered input before resolving the run", () => {
    const rows = [row("c", "2026-08-12"), row("a", "2026-08-10"), row("b", "2026-08-11")];
    expect(contiguousRunContaining(rows, "2026-08-10").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("returns a single-element run for a lone day", () => {
    const rows = [row("a", "2026-08-10"), row("c", "2026-08-13")];
    expect(contiguousRunContaining(rows, "2026-08-13").map((r) => r.id)).toEqual(["c"]);
  });

  it("returns [] when the target day is not present", () => {
    const rows = [row("a", "2026-08-10")];
    expect(contiguousRunContaining(rows, "2026-08-11")).toEqual([]);
  });

  it("bridges a month boundary (28 Feb → 1 Mar)", () => {
    const rows = [row("a", "2024-02-28"), row("b", "2024-02-29"), row("c", "2024-03-01")];
    expect(contiguousRunContaining(rows, "2024-02-29").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

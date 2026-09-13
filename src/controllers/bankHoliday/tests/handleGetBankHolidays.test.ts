import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockEnsureBankHolidays } = vi.hoisted(() => ({ mockEnsureBankHolidays: vi.fn() }));

vi.mock("../../../services/bankHoliday/bankHolidayServices.js", () => ({
  ensureBankHolidays: mockEnsureBankHolidays,
}));

import { handleGetBankHolidays } from "../handleGetBankHolidays.js";
import { makeReqRes } from "../../../tests/testUtils.js";

const storedRow = {
  id: "bh-1",
  date: "2026-01-01",
  name: "New Year's Day",
  country: "CZ",
  region: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("handleGetBankHolidays", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureBankHolidays.mockResolvedValue([]);
  });

  it("asks for the coerced year and the upper-cased country", async () => {
    const { req, res } = makeReqRes({ query: { country: "cz", year: "2026" } });

    await handleGetBankHolidays(req, res);

    expect(mockEnsureBankHolidays).toHaveBeenCalledWith(2026, "CZ", undefined);
  });

  it("passes a region through, which the fill deliberately never answers", async () => {
    const { req, res } = makeReqRes({ query: { country: "CZ", year: "2026", region: "PR" } });

    await handleGetBankHolidays(req, res);

    expect(mockEnsureBankHolidays).toHaveBeenCalledWith(2026, "CZ", "PR");
    expect(vi.mocked(res.json).mock.calls[0]?.[0]).toEqual([]);
  });

  it("drops the stored row's bookkeeping and reads a null region as absent", async () => {
    mockEnsureBankHolidays.mockResolvedValue([storedRow]);
    const { req, res } = makeReqRes({ query: { country: "CZ", year: "2026" } });

    await handleGetBankHolidays(req, res);

    expect(vi.mocked(res.json).mock.calls[0]?.[0]).toEqual([
      { date: "2026-01-01", name: "New Year's Day", country: "CZ", region: undefined },
    ]);
  });
});

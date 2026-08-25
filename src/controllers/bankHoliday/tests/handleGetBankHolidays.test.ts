import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockListBankHolidays, mockInsertBankHolidays, mockComputePublicHolidays } = vi.hoisted(
  () => ({
    mockListBankHolidays: vi.fn(),
    mockInsertBankHolidays: vi.fn(),
    mockComputePublicHolidays: vi.fn(),
  })
);

vi.mock("../../../services/bankHoliday/bankHolidayServices.js", () => ({
  listBankHolidays: mockListBankHolidays,
  insertBankHolidays: mockInsertBankHolidays,
}));

vi.mock("../../../services/bankHoliday/holidayDataset.js", () => ({
  computePublicHolidays: mockComputePublicHolidays,
  isSupportedCountry: (code: string) => code === "CZ",
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

const computedRow = { id: "bh-1", date: "2026-01-01", name: "New Year's Day", country: "CZ" };

describe("handleGetBankHolidays", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves cached rows without touching the dataset", async () => {
    mockListBankHolidays.mockResolvedValue([storedRow]);
    const { req, res } = makeReqRes({ query: { country: "CZ", year: "2026" } });

    await handleGetBankHolidays(req, res);

    expect(mockComputePublicHolidays).not.toHaveBeenCalled();
    expect(mockInsertBankHolidays).not.toHaveBeenCalled();
    expect(vi.mocked(res.json).mock.calls[0]?.[0]).toEqual([
      { date: "2026-01-01", name: "New Year's Day", country: "CZ", region: undefined },
    ]);
  });

  it("computes, inserts and re-lists on a first request for a supported country", async () => {
    mockListBankHolidays.mockResolvedValueOnce([]).mockResolvedValueOnce([storedRow]);
    mockComputePublicHolidays.mockReturnValue([computedRow]);
    const { req, res } = makeReqRes({ query: { country: "CZ", year: "2026" } });

    await handleGetBankHolidays(req, res);

    expect(mockComputePublicHolidays).toHaveBeenCalledWith("CZ", 2026);
    expect(mockInsertBankHolidays).toHaveBeenCalledWith([computedRow]);
    expect(mockListBankHolidays).toHaveBeenCalledTimes(2);
    expect(vi.mocked(res.json).mock.calls[0]?.[0]).toHaveLength(1);
  });

  it("returns an empty array for an unsupported country without inserting", async () => {
    mockListBankHolidays.mockResolvedValue([]);
    const { req, res } = makeReqRes({ query: { country: "ZZ", year: "2026" } });

    await handleGetBankHolidays(req, res);

    expect(mockComputePublicHolidays).not.toHaveBeenCalled();
    expect(mockInsertBankHolidays).not.toHaveBeenCalled();
    expect(vi.mocked(res.json).mock.calls[0]?.[0]).toEqual([]);
  });

  it("never fills from a region-filtered miss", async () => {
    // The dataset rows carry no region, so a refill would duplicate the
    // already-cached country rather than satisfy the region query.
    mockListBankHolidays.mockResolvedValue([]);
    const { req, res } = makeReqRes({
      query: { country: "CZ", year: "2026", region: "PR" },
    });

    await handleGetBankHolidays(req, res);

    expect(mockComputePublicHolidays).not.toHaveBeenCalled();
    expect(mockInsertBankHolidays).not.toHaveBeenCalled();
    expect(vi.mocked(res.json).mock.calls[0]?.[0]).toEqual([]);
  });

  it("does not insert when the dataset yields nothing", async () => {
    mockListBankHolidays.mockResolvedValue([]);
    mockComputePublicHolidays.mockReturnValue([]);
    const { req, res } = makeReqRes({ query: { country: "CZ", year: "2026" } });

    await handleGetBankHolidays(req, res);

    expect(mockInsertBankHolidays).not.toHaveBeenCalled();
    expect(mockListBankHolidays).toHaveBeenCalledTimes(1);
    expect(vi.mocked(res.json).mock.calls[0]?.[0]).toEqual([]);
  });
});

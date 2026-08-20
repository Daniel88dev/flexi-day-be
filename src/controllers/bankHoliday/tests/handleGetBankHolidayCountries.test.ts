import { describe, it, expect, vi } from "vitest";

vi.mock("../../../services/bankHoliday/holidayDataset.js", () => ({
  getSupportedCountries: () => [
    { code: "CZ", name: "Czech Republic" },
    { code: "DE", name: "Germany" },
  ],
}));

import { handleGetBankHolidayCountries } from "../handleGetBankHolidayCountries.js";
import { makeReqRes } from "../../../tests/testUtils.js";

describe("handleGetBankHolidayCountries", () => {
  it("returns the supported countries", async () => {
    const { req, res } = makeReqRes();

    await handleGetBankHolidayCountries(req, res);

    expect(vi.mocked(res.status).mock.calls[0]?.[0]).toBe(200);
    expect(vi.mocked(res.json).mock.calls[0]?.[0]).toEqual([
      { code: "CZ", name: "Czech Republic" },
      { code: "DE", name: "Germany" },
    ]);
  });
});

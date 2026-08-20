import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockUpdateGroupHolidayCountry,
  mockPostChanges,
  mockAssertGroupAdmin,
  mockAssertGroupWritable,
} = vi.hoisted(() => ({
  mockUpdateGroupHolidayCountry: vi.fn(),
  mockPostChanges: vi.fn(),
  mockAssertGroupAdmin: vi.fn(),
  mockAssertGroupWritable: vi.fn(),
}));

vi.mock("../../../middleware/authSession.js", () => ({ getAuth: vi.fn() }));

vi.mock("../../groupUser/utils.js", () => ({
  assertGroupAdmin: mockAssertGroupAdmin,
}));

vi.mock("../../../services/billing/guards.js", () => ({
  assertGroupWritable: mockAssertGroupWritable,
}));

vi.mock("../../../services/DBServices.js", () => ({
  createDBServices: () => ({
    group: { updateGroupHolidayCountry: mockUpdateGroupHolidayCountry },
    changes: { postChanges: mockPostChanges },
  }),
}));

import { handlePutGroupHolidayCountry } from "../handlePutGroupHolidayCountry.js";
import { getAuth } from "../../../middleware/authSession.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";
import AppError from "../../../utils/appError.js";

const groupId = "550e8400-e29b-41d4-a716-446655440000";
const group = { id: groupId, groupName: "Engineering", holidayCountry: "CZ" };

describe("handlePutGroupHolidayCountry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuth).mockReturnValue(mockAuthData);
    mockAssertGroupAdmin.mockResolvedValue(undefined);
    mockAssertGroupWritable.mockResolvedValue(undefined);
    mockUpdateGroupHolidayCountry.mockResolvedValue(group);
  });

  it("updates the country and writes an audit row", async () => {
    const { req, res } = makeReqRes({ params: { groupId }, body: { holidayCountry: "CZ" } });

    await handlePutGroupHolidayCountry(req, res);

    expect(mockAssertGroupAdmin).toHaveBeenCalledWith(mockAuthData.userId, groupId);
    expect(mockAssertGroupWritable).toHaveBeenCalledWith(groupId);
    expect(mockUpdateGroupHolidayCountry).toHaveBeenCalledWith(groupId, "CZ");
    expect(mockPostChanges).toHaveBeenCalledWith(
      expect.objectContaining({ groupId, changeDetail: "Public holidays set to CZ" })
    );
    expect(vi.mocked(res.status).mock.calls[0]?.[0]).toBe(200);
    expect(vi.mocked(res.json).mock.calls[0]?.[0]).toEqual(group);
  });

  it("clears the country with null and audits the disable", async () => {
    mockUpdateGroupHolidayCountry.mockResolvedValue({ ...group, holidayCountry: null });
    const { req, res } = makeReqRes({ params: { groupId }, body: { holidayCountry: null } });

    await handlePutGroupHolidayCountry(req, res);

    expect(mockUpdateGroupHolidayCountry).toHaveBeenCalledWith(groupId, null);
    expect(mockPostChanges).toHaveBeenCalledWith(
      expect.objectContaining({ changeDetail: "Public holidays disabled" })
    );
  });

  it("404s for a group that does not exist", async () => {
    mockUpdateGroupHolidayCountry.mockResolvedValue(undefined);
    const { req, res } = makeReqRes({ params: { groupId }, body: { holidayCountry: "CZ" } });

    await expect(handlePutGroupHolidayCountry(req, res)).rejects.toThrow("Group not found");
    expect(mockPostChanges).not.toHaveBeenCalled();
  });

  it("propagates the 403 from the admin check without writing", async () => {
    mockAssertGroupAdmin.mockRejectedValue(
      new AppError({ message: "No access for related group", code: 403, logging: false })
    );
    const { req, res } = makeReqRes({ params: { groupId }, body: { holidayCountry: "CZ" } });

    await expect(handlePutGroupHolidayCountry(req, res)).rejects.toThrow(
      "No access for related group"
    );
    expect(mockUpdateGroupHolidayCountry).not.toHaveBeenCalled();
  });

  it("propagates the 402 billing guard without writing", async () => {
    mockAssertGroupWritable.mockRejectedValue(
      new AppError({ message: "Plan lapsed", code: 402, logging: false })
    );
    const { req, res } = makeReqRes({ params: { groupId }, body: { holidayCountry: "CZ" } });

    await expect(handlePutGroupHolidayCountry(req, res)).rejects.toThrow("Plan lapsed");
    expect(mockUpdateGroupHolidayCountry).not.toHaveBeenCalled();
  });
});

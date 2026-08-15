import { describe, it, expect, vi, beforeEach } from "vitest";

// Billing plan-limit guards are no-ops here; their behavior has its own suite.
vi.mock("../../../services/billing/guards.js", () => ({
  assertCanCreateGroup: vi.fn(),
  assertCanAddMember: vi.fn(),
  assertGroupWritable: vi.fn(),
  assertGroupsWritable: vi.fn(),
}));

const { mockGetGroupUser, mockGetUserYearGroupQuotas, mockUpsertUserYearQuota, mockPostChanges } =
  vi.hoisted(() => ({
    mockGetGroupUser: vi.fn(),
    mockGetUserYearGroupQuotas: vi.fn(),
    mockUpsertUserYearQuota: vi.fn(),
    mockPostChanges: vi.fn(),
  }));

vi.mock("../../../middleware/authSession.js", () => ({
  getAuth: vi.fn(),
}));

vi.mock("../../../db/db.js", () => ({
  db: {
    transaction: vi.fn((callback: (tx: unknown) => unknown) => callback({})),
  },
}));

vi.mock("../../../services/DBServices.js", () => ({
  createDBServices: () => ({
    groupUser: { getGroupUser: mockGetGroupUser },
    userYearQuotas: {
      getUserYearGroupQuotas: mockGetUserYearGroupQuotas,
      upsertUserYearQuota: mockUpsertUserYearQuota,
    },
    changes: { postChanges: mockPostChanges },
  }),
}));

import { handlePutUserQuota } from "../handlePutUserQuota.js";
import { getAuth } from "../../../middleware/authSession.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";

const groupId = "550e8400-e29b-41d4-a716-446655440000";
// better-auth user ids are opaque non-UUID strings, not UUIDs.
const memberId = "aBcD1234eFgH5678iJkL9012mNoP3456";

// Shaped as the validation middleware leaves it, so `carriedOverDays` is
// already defaulted by the time the controller sees the body.
const body = {
  userId: memberId,
  year: 2026,
  vacationDays: 25,
  homeOfficeDays: 60,
  carriedOverDays: 0,
};

describe("handlePutUserQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthData);
  });

  it("upserts the quota and records an audit entry when the caller is an admin", async () => {
    const { req, res } = makeReqRes({ params: { groupId }, body });

    mockGetGroupUser
      .mockResolvedValueOnce({ adminAccess: true })
      .mockResolvedValueOnce({ userId: memberId });
    mockGetUserYearGroupQuotas.mockResolvedValue([]);
    mockUpsertUserYearQuota.mockResolvedValue({ id: "q-1", ...body, relatedYear: "2026" });

    await handlePutUserQuota(req, res);

    expect(mockUpsertUserYearQuota).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: memberId,
        groupId,
        relatedYear: "2026",
        vacationDays: 25,
        homeOfficeDays: 60,
        carriedOverDays: 0,
      }),
      expect.anything()
    );
    expect(mockPostChanges).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("stores carry-over and names it in the audit entry", async () => {
    const { req, res } = makeReqRes({
      params: { groupId },
      body: { ...body, carriedOverDays: 4 },
    });

    mockGetGroupUser
      .mockResolvedValueOnce({ adminAccess: true })
      .mockResolvedValueOnce({ userId: memberId });
    mockGetUserYearGroupQuotas.mockResolvedValue([
      { id: "q-1", vacationDays: 25, homeOfficeDays: 60, carriedOverDays: 0 },
    ]);
    mockUpsertUserYearQuota.mockResolvedValue({ id: "q-1", ...body, carriedOverDays: 4 });

    await handlePutUserQuota(req, res);

    expect(mockUpsertUserYearQuota).toHaveBeenCalledWith(
      expect.objectContaining({ carriedOverDays: 4 }),
      expect.anything()
    );
    expect(mockPostChanges).toHaveBeenCalledWith(
      expect.objectContaining({ changeDetail: "Quota for 2026: carried over 0 → 4" }),
      expect.anything()
    );
  });

  it("rejects callers without admin access", async () => {
    const { req, res } = makeReqRes({ params: { groupId }, body });

    mockGetGroupUser.mockResolvedValueOnce({ adminAccess: false });

    await expect(handlePutUserQuota(req, res)).rejects.toThrow("No permission for related group");
    expect(mockUpsertUserYearQuota).not.toHaveBeenCalled();
  });

  it("rejects quota edits for users outside the group", async () => {
    const { req, res } = makeReqRes({ params: { groupId }, body });

    mockGetGroupUser.mockResolvedValueOnce({ adminAccess: true }).mockResolvedValueOnce(undefined);

    await expect(handlePutUserQuota(req, res)).rejects.toThrow(
      "User is not a member of this group"
    );
    expect(mockUpsertUserYearQuota).not.toHaveBeenCalled();
  });
});

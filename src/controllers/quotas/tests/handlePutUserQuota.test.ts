import { describe, it, expect, vi, beforeEach } from "vitest";

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

const body = { userId: memberId, year: 2026, vacationDays: 25, homeOfficeDays: 60 };

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
      }),
      expect.anything()
    );
    expect(mockPostChanges).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
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

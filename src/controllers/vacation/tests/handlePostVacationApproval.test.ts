import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockGetVacationById,
  mockGetGroupsWhereUserCanApprove,
  mockApproveVacation,
  mockCreateVacationEvent,
  mockAssertApprovalWithinQuota,
} = vi.hoisted(() => ({
  mockGetVacationById: vi.fn(),
  mockGetGroupsWhereUserCanApprove: vi.fn(),
  mockApproveVacation: vi.fn(),
  mockCreateVacationEvent: vi.fn(),
  mockAssertApprovalWithinQuota: vi.fn(),
}));

vi.mock("../../../middleware/authSession.js", () => ({
  getAuth: vi.fn(),
}));

vi.mock("../../../db/db.js", () => ({
  db: {
    transaction: vi.fn((callback) => callback({})),
  },
}));

vi.mock("../../../services/DBServices.js", () => ({
  createDBServices: () => ({
    vacation: {
      getVacationById: mockGetVacationById,
      approveVacation: mockApproveVacation,
    },
    group: {
      getGroupsWhereUserCanApprove: mockGetGroupsWhereUserCanApprove,
    },
    vacationEvent: {
      createVacationEvent: mockCreateVacationEvent,
    },
  }),
}));

vi.mock("../../../services/vacation/quotaGuard.js", () => ({
  assertApprovalWithinQuota: mockAssertApprovalWithinQuota,
}));

import { handlePostVacationApproval } from "../handlePostVacationApproval.js";
import { getAuth } from "../../../middleware/authSession.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";

const VACATION_ID = "550e8400-e29b-41d4-a716-446655440000";

const pendingVacation = (over: Record<string, unknown> = {}) => ({
  id: VACATION_ID,
  userId: "vacation_user_123",
  groupId: "group_123",
  requestedDay: "2024-03-15",
  startTime: "09:00",
  endTime: "17:00",
  vacationType: "VACATION",
  halfDay: false,
  approvedAt: null,
  rejectedAt: null,
  deletedAt: null,
  ...over,
});

describe("handlePostVacationApproval", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthData);
    mockGetGroupsWhereUserCanApprove.mockResolvedValue(["group_123"]);
    mockAssertApprovalWithinQuota.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should approve vacation successfully when the caller may decide on it", async () => {
    const { req, res } = makeReqRes({ params: { id: VACATION_ID } });

    mockGetVacationById.mockResolvedValue(pendingVacation());
    mockApproveVacation.mockResolvedValue(undefined);

    await handlePostVacationApproval(req, res);

    expect(getAuth).toHaveBeenCalledWith(req);
    expect(mockGetVacationById).toHaveBeenCalledWith(VACATION_ID, {});
    expect(mockGetGroupsWhereUserCanApprove).toHaveBeenCalledWith(["group_123"], "user_123", {});
    expect(mockApproveVacation).toHaveBeenCalledWith(VACATION_ID, "user_123", {});
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ message: "Vacation approved" });
  });

  it("stores the approver's note on the APPROVED event", async () => {
    const { req, res } = makeReqRes({
      params: { id: VACATION_ID },
      body: { reason: "Enjoy the break" },
    });

    mockGetVacationById.mockResolvedValue(pendingVacation());
    mockApproveVacation.mockResolvedValue(undefined);

    await handlePostVacationApproval(req, res);

    expect(mockCreateVacationEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "APPROVED", reason: "Enjoy the break" }),
      {}
    );
  });

  it("should throw validation error for invalid UUID format", async () => {
    const { req, res } = makeReqRes({ params: { id: "invalid-uuid" } });

    await expect(handlePostVacationApproval(req, res)).rejects.toThrow();
    expect(mockGetVacationById).not.toHaveBeenCalled();
  });

  it("should throw 404 error when vacation is not found", async () => {
    const { req, res } = makeReqRes({ params: { id: VACATION_ID } });

    mockGetVacationById.mockResolvedValue(null);

    await expect(handlePostVacationApproval(req, res)).rejects.toThrow("Vacation not found");
    expect(mockGetGroupsWhereUserCanApprove).not.toHaveBeenCalled();
    expect(mockApproveVacation).not.toHaveBeenCalled();
  });

  it("refuses a caller who is not an approver of the request's group", async () => {
    const { req, res } = makeReqRes({ params: { id: VACATION_ID } });

    mockGetVacationById.mockResolvedValue(pendingVacation());
    mockGetGroupsWhereUserCanApprove.mockResolvedValue([]);

    await expect(handlePostVacationApproval(req, res)).rejects.toThrow(
      "You are not allowed to approve one or more of these requests"
    );
    expect(mockApproveVacation).not.toHaveBeenCalled();
  });

  it("refuses an approver deciding on their own request", async () => {
    const { req, res } = makeReqRes({ params: { id: VACATION_ID } });

    mockGetVacationById.mockResolvedValue(pendingVacation({ userId: "user_123" }));

    await expect(handlePostVacationApproval(req, res)).rejects.toThrow(
      "You cannot decide on your own leave request"
    );
    expect(mockApproveVacation).not.toHaveBeenCalled();
  });

  it("refuses to overturn a request that has already been rejected", async () => {
    const { req, res } = makeReqRes({ params: { id: VACATION_ID } });

    mockGetVacationById.mockResolvedValue(pendingVacation({ rejectedAt: new Date() }));

    await expect(handlePostVacationApproval(req, res)).rejects.toThrow(
      "This request has already been decided"
    );
    expect(mockApproveVacation).not.toHaveBeenCalled();
  });

  it("refuses to re-approve a request that is already approved", async () => {
    const { req, res } = makeReqRes({ params: { id: VACATION_ID } });

    mockGetVacationById.mockResolvedValue(pendingVacation({ approvedAt: new Date() }));

    await expect(handlePostVacationApproval(req, res)).rejects.toThrow(
      "This request has already been decided"
    );
    expect(mockApproveVacation).not.toHaveBeenCalled();
  });

  it("does not approve days the requester has no allowance left for", async () => {
    const { req, res } = makeReqRes({ params: { id: VACATION_ID } });

    mockGetVacationById.mockResolvedValue(pendingVacation());
    mockAssertApprovalWithinQuota.mockRejectedValue(
      new Error("This would exceed the allowance for that leave type")
    );

    await expect(handlePostVacationApproval(req, res)).rejects.toThrow(
      "This would exceed the allowance for that leave type"
    );
    expect(mockApproveVacation).not.toHaveBeenCalled();
  });

  it("should handle database service errors from getVacationById", async () => {
    const { req, res } = makeReqRes({ params: { id: VACATION_ID } });

    mockGetVacationById.mockRejectedValue(new Error("Database connection failed"));

    await expect(handlePostVacationApproval(req, res)).rejects.toThrow(
      "Database connection failed"
    );
    expect(mockGetVacationById).toHaveBeenCalled();
  });

  it("should handle database service errors from approveVacation", async () => {
    const { req, res } = makeReqRes({ params: { id: VACATION_ID } });

    mockGetVacationById.mockResolvedValue(pendingVacation());
    mockApproveVacation.mockRejectedValue(new Error("Failed to update vacation"));

    await expect(handlePostVacationApproval(req, res)).rejects.toThrow("Failed to update vacation");
  });

  it("authorizes against the group the request belongs to", async () => {
    const { req, res } = makeReqRes({ params: { id: VACATION_ID } });

    mockGetVacationById.mockResolvedValue(pendingVacation({ groupId: "specific_group_789" }));
    mockGetGroupsWhereUserCanApprove.mockResolvedValue(["specific_group_789"]);
    mockApproveVacation.mockResolvedValue(undefined);

    await handlePostVacationApproval(req, res);

    expect(mockGetGroupsWhereUserCanApprove).toHaveBeenCalledWith(
      ["specific_group_789"],
      "user_123",
      {}
    );
  });
});

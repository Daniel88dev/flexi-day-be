import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockGetVacationById,
  mockGetApprovalUsers,
  mockApproveVacation,
} = vi.hoisted(() => ({
  mockGetVacationById: vi.fn(),
  mockGetApprovalUsers: vi.fn(),
  mockApproveVacation: vi.fn(),
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
      getApprovalUsers: mockGetApprovalUsers,
    },
  }),
}));

import { handlePostVacationApproval } from "../handlePostVacationApproval.js";
import { getAuth } from "../../../middleware/authSession.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";

describe("handlePostVacationApproval", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthData);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should approve vacation successfully when user is main approver", async () => {
    const { req, res } = makeReqRes({
      params: { id: "550e8400-e29b-41d4-a716-446655440000" },
    });

    const mockVacationData = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      userId: "vacation_user_123",
      groupId: "group_123",
      requestedDay: "2024-03-15",
      startTime: "09:00",
      endTime: "17:00",
      vacationType: "Vacation",
    };

    mockGetVacationById.mockResolvedValue(mockVacationData);
    mockGetApprovalUsers.mockResolvedValue({
      mainApprovalUserId: "user_123",
      tempApprovalUserId: "temp_user_456",
    });
    mockApproveVacation.mockResolvedValue(undefined);

    await handlePostVacationApproval(req, res);

    expect(getAuth).toHaveBeenCalledWith(req);
    expect(mockGetVacationById).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      {}
    );
    expect(mockGetApprovalUsers).toHaveBeenCalledWith("group_123", {});
    expect(mockApproveVacation).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      "user_123",
      {}
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ message: "Vacation approved" });
  });

  it("should approve vacation successfully when user is temp approver", async () => {
    const { req, res } = makeReqRes({
      params: { id: "550e8400-e29b-41d4-a716-446655440000" },
    });

    const mockVacationData = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      userId: "vacation_user_123",
      groupId: "group_123",
      requestedDay: "2024-03-15",
      startTime: "09:00",
      endTime: "17:00",
      vacationType: "Vacation",
    };

    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue({
      userId: "temp_user_456",
      sessionId: "session_456",
      userName: "Temp Approver",
      userEmail: "temp@example.com",
      emailVerified: true,
    });

    mockGetVacationById.mockResolvedValue(mockVacationData);
    mockGetApprovalUsers.mockResolvedValue({
      mainApprovalUserId: "main_user_123",
      tempApprovalUserId: "temp_user_456",
    });
    mockApproveVacation.mockResolvedValue(undefined);

    await handlePostVacationApproval(req, res);

    expect(mockApproveVacation).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      "temp_user_456",
      {}
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ message: "Vacation approved" });
  });

  it("should throw validation error for invalid UUID format", async () => {
    const { req, res } = makeReqRes({
      params: { id: "invalid-uuid" },
    });

    await expect(handlePostVacationApproval(req, res)).rejects.toThrow();
    expect(mockGetVacationById).not.toHaveBeenCalled();
  });

  it("should throw 404 error when vacation is not found", async () => {
    const { req, res } = makeReqRes({
      params: { id: "550e8400-e29b-41d4-a716-446655440000" },
    });

    mockGetVacationById.mockResolvedValue(null);

    await expect(handlePostVacationApproval(req, res)).rejects.toThrow(
      "Vacation not found"
    );
    expect(mockGetApprovalUsers).not.toHaveBeenCalled();
    expect(mockApproveVacation).not.toHaveBeenCalled();
  });

  it("should throw 404 error when approvers cannot be verified", async () => {
    const { req, res } = makeReqRes({
      params: { id: "550e8400-e29b-41d4-a716-446655440000" },
    });

    const mockVacationData = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      userId: "vacation_user_123",
      groupId: "group_123",
      requestedDay: "2024-03-15",
      startTime: "09:00",
      endTime: "17:00",
      vacationType: "Vacation",
    };

    mockGetVacationById.mockResolvedValue(mockVacationData);
    mockGetApprovalUsers.mockResolvedValue(null);

    await expect(handlePostVacationApproval(req, res)).rejects.toThrow(
      "Not able to verify approvers"
    );
    expect(mockApproveVacation).not.toHaveBeenCalled();
  });

  it("should throw 403 error when user is not an approver", async () => {
    const { req, res } = makeReqRes({
      params: { id: "550e8400-e29b-41d4-a716-446655440000" },
    });

    const mockVacationData = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      userId: "vacation_user_123",
      groupId: "group_123",
      requestedDay: "2024-03-15",
      startTime: "09:00",
      endTime: "17:00",
      vacationType: "Vacation",
    };

    mockGetVacationById.mockResolvedValue(mockVacationData);
    mockGetApprovalUsers.mockResolvedValue({
      mainApprovalUserId: "main_user_999",
      tempApprovalUserId: "temp_user_888",
    });

    await expect(handlePostVacationApproval(req, res)).rejects.toThrow(
      "You are not allowed to approve this vacation"
    );
    expect(mockApproveVacation).not.toHaveBeenCalled();
  });

  it("should handle database service errors from getVacationById", async () => {
    const { req, res } = makeReqRes({
      params: { id: "550e8400-e29b-41d4-a716-446655440000" },
    });

    const dbError = new Error("Database connection failed");
    mockGetVacationById.mockRejectedValue(dbError);

    await expect(handlePostVacationApproval(req, res)).rejects.toThrow(
      "Database connection failed"
    );
    expect(mockGetVacationById).toHaveBeenCalled();
  });

  it("should handle database service errors from approveVacation", async () => {
    const { req, res } = makeReqRes({
      params: { id: "550e8400-e29b-41d4-a716-446655440000" },
    });

    const mockVacationData = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      userId: "vacation_user_123",
      groupId: "group_123",
      requestedDay: "2024-03-15",
      startTime: "09:00",
      endTime: "17:00",
      vacationType: "Vacation",
    };

    mockGetVacationById.mockResolvedValue(mockVacationData);
    mockGetApprovalUsers.mockResolvedValue({
      mainApprovalUserId: "user_123",
      tempApprovalUserId: "temp_user_456",
    });

    const dbError = new Error("Failed to update vacation");
    mockApproveVacation.mockRejectedValue(dbError);

    await expect(handlePostVacationApproval(req, res)).rejects.toThrow(
      "Failed to update vacation"
    );
  });

  it("should use groupId from vacation data to fetch approvers", async () => {
    const { req, res } = makeReqRes({
      params: { id: "550e8400-e29b-41d4-a716-446655440000" },
    });

    const mockVacationData = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      userId: "vacation_user_123",
      groupId: "specific_group_789",
      requestedDay: "2024-03-15",
      startTime: "09:00",
      endTime: "17:00",
      vacationType: "Vacation",
    };

    mockGetVacationById.mockResolvedValue(mockVacationData);
    mockGetApprovalUsers.mockResolvedValue({
      mainApprovalUserId: "user_123",
      tempApprovalUserId: "temp_user_456",
    });
    mockApproveVacation.mockResolvedValue(undefined);

    await handlePostVacationApproval(req, res);

    expect(mockGetApprovalUsers).toHaveBeenCalledWith("specific_group_789", {});
  });
});

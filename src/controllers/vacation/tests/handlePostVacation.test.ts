import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockPostVacation, mockGetGroupUser, mockGetApprovalUsers } = vi.hoisted(
  () => ({
    mockPostVacation: vi.fn(),
    mockGetGroupUser: vi.fn(),
    mockGetApprovalUsers: vi.fn(),
  })
);

vi.mock("../../../utils/dateFunc.js", () => ({
  formatDateToISOString: vi.fn(),
}));

vi.mock("../../../utils/generateUUID.js", () => ({
  generateRandomUUID: vi.fn(),
}));

vi.mock("../../../middleware/authSession.js", () => ({
  getAuth: vi.fn(),
}));

vi.mock("../../../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
  },
}));

vi.mock("../../../services/DBServices.js", () => ({
  createDBServices: () => ({
    vacation: {
      postVacation: mockPostVacation,
    },
    groupUser: {
      getGroupUser: mockGetGroupUser,
    },
    group: {
      getApprovalUsers: mockGetApprovalUsers,
    },
  }),
}));

import { handlePostVacation } from "../handlePostVacation.js";
import { formatDateToISOString } from "../../../utils/dateFunc.js";
import { generateRandomUUID } from "../../../utils/generateUUID.js";
import { getAuth } from "../../../middleware/authSession.js";
import { logger } from "../../../middleware/logger.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";

describe("handlePostVacation", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default mocks
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthData);

    (formatDateToISOString as ReturnType<typeof vi.fn>).mockReturnValue(
      "2024-03-15"
    );

    (generateRandomUUID as ReturnType<typeof vi.fn>).mockReturnValue(
      "uuid_123"
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should create vacation successfully with valid data", async () => {
    const { req, res } = makeReqRes({
      body: {
        groupId: "group_123",
        requestedDay: "2024-03-15",
        startTime: "09:00",
        endTime: "17:00",
      },
    });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: true,
    });

    const mockVacationRecord = {
      id: "uuid_123",
      userId: "user_123",
      groupId: "group_123",
      requestedDay: "2024-03-15",
      startTime: "09:00",
      endTime: "17:00",
      vacationType: "Vacation",
    };

    mockPostVacation.mockResolvedValue(mockVacationRecord);
    mockGetApprovalUsers.mockResolvedValue(null);

    await handlePostVacation(req, res);

    expect(getAuth).toHaveBeenCalledWith(req);
    expect(mockGetGroupUser).toHaveBeenCalledWith("user_123", "group_123");
    expect(generateRandomUUID).toHaveBeenCalled();
    expect(formatDateToISOString).toHaveBeenCalledWith("2024-03-15");
    expect(mockPostVacation).toHaveBeenCalledWith({
      id: "uuid_123",
      userId: "user_123",
      groupId: "group_123",
      requestedDay: "2024-03-15",
      startTime: "09:00",
      endTime: "17:00",
      vacationType: "VACATION",
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(mockVacationRecord);
  });

  it("should throw 403 error when user has no access to group", async () => {
    const { req, res } = makeReqRes({
      body: {
        groupId: "group_123",
        requestedDay: "2024-03-15",
        startTime: "09:00",
        endTime: "17:00",
      },
    });

    mockGetGroupUser.mockResolvedValue(null);

    await expect(handlePostVacation(req, res)).rejects.toThrow(
      "No access for related group"
    );
    expect(mockPostVacation).not.toHaveBeenCalled();
  });

  it("should throw 403 error when user is not a controlled user", async () => {
    const { req, res } = makeReqRes({
      body: {
        groupId: "group_123",
        requestedDay: "2024-03-15",
        startTime: "09:00",
        endTime: "17:00",
      },
    });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: false,
    });

    await expect(handlePostVacation(req, res)).rejects.toThrow(
      "No access for related group"
    );
    expect(mockPostVacation).not.toHaveBeenCalled();
  });

  it("should throw 500 error when vacation creation fails", async () => {
    const { req, res } = makeReqRes({
      body: {
        groupId: "group_123",
        requestedDay: "2024-03-15",
        startTime: "09:00",
        endTime: "17:00",
      },
    });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: true,
    });

    mockPostVacation.mockResolvedValue(null);

    await expect(handlePostVacation(req, res)).rejects.toThrow(
      "Failed to create vacation"
    );
  });

  it("should log info when main approval user email is available", async () => {
    const { req, res } = makeReqRes({
      body: {
        groupId: "group_123",
        requestedDay: "2024-03-15",
        startTime: "09:00",
        endTime: "17:00",
      },
    });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: true,
    });

    const mockVacationRecord = {
      id: "uuid_123",
      userId: "user_123",
      groupId: "group_123",
      requestedDay: "2024-03-15",
      startTime: "09:00",
      endTime: "17:00",
      vacationType: "Vacation",
    };

    mockPostVacation.mockResolvedValue(mockVacationRecord);
    mockGetApprovalUsers.mockResolvedValue({
      mainApprovalUserEmail: "approver@example.com",
    });

    await handlePostVacation(req, res);

    expect(mockGetApprovalUsers).toHaveBeenCalledWith("group_123");
    expect(logger.info).toHaveBeenCalledWith(
      "notification email not-sent (not finished"
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("should log info when temp approval user email is available", async () => {
    const { req, res } = makeReqRes({
      body: {
        groupId: "group_123",
        requestedDay: "2024-03-15",
        startTime: "09:00",
        endTime: "17:00",
      },
    });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: true,
    });

    const mockVacationRecord = {
      id: "uuid_123",
      userId: "user_123",
      groupId: "group_123",
      requestedDay: "2024-03-15",
      startTime: "09:00",
      endTime: "17:00",
      vacationType: "Vacation",
    };

    mockPostVacation.mockResolvedValue(mockVacationRecord);
    mockGetApprovalUsers.mockResolvedValue({
      tempApprovalUserEmail: "temp_approver@example.com",
    });

    await handlePostVacation(req, res);

    expect(mockGetApprovalUsers).toHaveBeenCalledWith("group_123");
    expect(logger.info).toHaveBeenCalledWith(
      "notification email not-sent (not finished"
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("should not log info when no approval user emails are available", async () => {
    const { req, res } = makeReqRes({
      body: {
        groupId: "group_123",
        requestedDay: "2024-03-15",
        startTime: "09:00",
        endTime: "17:00",
      },
    });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: true,
    });

    const mockVacationRecord = {
      id: "uuid_123",
      userId: "user_123",
      groupId: "group_123",
      requestedDay: "2024-03-15",
      startTime: "09:00",
      endTime: "17:00",
      vacationType: "Vacation",
    };

    mockPostVacation.mockResolvedValue(mockVacationRecord);
    mockGetApprovalUsers.mockResolvedValue({
      mainApprovalUserEmail: null,
      tempApprovalUserEmail: null,
    });

    await handlePostVacation(req, res);

    expect(mockGetApprovalUsers).toHaveBeenCalledWith("group_123");
    expect(logger.info).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("should use the correct userId from auth", async () => {
    const { req, res } = makeReqRes({
      body: {
        groupId: "group_123",
        requestedDay: "2024-03-15",
        startTime: "09:00",
        endTime: "17:00",
      },
    });

    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue({
      userId: "different_user_456",
      sessionId: "session_456",
      userName: "Different User",
      userEmail: "different@example.com",
      emailVerified: true,
    });

    mockGetGroupUser.mockResolvedValue({
      userId: "different_user_456",
      groupId: "group_123",
      controlledUser: true,
    });

    const mockVacationRecord = {
      id: "uuid_123",
      userId: "different_user_456",
      groupId: "group_123",
      requestedDay: "2024-03-15",
      startTime: "09:00",
      endTime: "17:00",
      vacationType: "Vacation",
    };

    mockPostVacation.mockResolvedValue(mockVacationRecord);
    mockGetApprovalUsers.mockResolvedValue(null);

    await handlePostVacation(req, res);

    expect(mockGetGroupUser).toHaveBeenCalledWith(
      "different_user_456",
      "group_123"
    );
    expect(mockPostVacation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "different_user_456",
      })
    );
  });

  it("should handle database service errors from getGroupUser", async () => {
    const { req, res } = makeReqRes({
      body: {
        groupId: "group_123",
        requestedDay: "2024-03-15",
        startTime: "09:00",
        endTime: "17:00",
      },
    });

    const dbError = new Error("Database connection failed");
    mockGetGroupUser.mockRejectedValue(dbError);

    await expect(handlePostVacation(req, res)).rejects.toThrow(
      "Database connection failed"
    );
    expect(mockGetGroupUser).toHaveBeenCalled();
    expect(mockPostVacation).not.toHaveBeenCalled();
  });

  it("should handle database service errors from postVacation", async () => {
    const { req, res } = makeReqRes({
      body: {
        groupId: "group_123",
        requestedDay: "2024-03-15",
        startTime: "09:00",
        endTime: "17:00",
      },
    });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: true,
    });

    const dbError = new Error("Insert failed");
    mockPostVacation.mockRejectedValue(dbError);

    await expect(handlePostVacation(req, res)).rejects.toThrow("Insert failed");
    expect(mockPostVacation).toHaveBeenCalled();
  });

  it("should pass correct vacation type to postVacation", async () => {
    const { req, res } = makeReqRes({
      body: {
        groupId: "group_123",
        requestedDay: "2024-03-15",
        startTime: "09:00",
        endTime: "17:00",
      },
    });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: true,
    });

    const mockVacationRecord = {
      id: "uuid_123",
      userId: "user_123",
      groupId: "group_123",
      requestedDay: "2024-03-15",
      startTime: "09:00",
      endTime: "17:00",
      vacationType: "Vacation",
    };

    mockPostVacation.mockResolvedValue(mockVacationRecord);
    mockGetApprovalUsers.mockResolvedValue(null);

    await handlePostVacation(req, res);

    expect(mockPostVacation).toHaveBeenCalledWith(
      expect.objectContaining({
        vacationType: "VACATION",
      })
    );
  });
});

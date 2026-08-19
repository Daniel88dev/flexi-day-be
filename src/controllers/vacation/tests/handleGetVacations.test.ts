import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

const {
  mockGetVacationsForUser,
  mockGetVacationsForGroup,
  mockGetScopeEntries,
  mockGetGroupsWhereUserCanApprove,
  mockGetGroupUser,
  mockHasMirrorIntoGroup,
} = vi.hoisted(() => ({
  mockGetVacationsForUser: vi.fn(),
  mockGetVacationsForGroup: vi.fn(),
  mockGetScopeEntries: vi.fn(),
  mockGetGroupsWhereUserCanApprove: vi.fn(),
  mockGetGroupUser: vi.fn(),
  mockHasMirrorIntoGroup: vi.fn(),
}));

vi.mock("../../../utils/dateFunc.js", () => ({
  formatStartAndEndDate: vi.fn(),
}));

vi.mock("../../../middleware/authSession.js", () => ({
  getAuth: vi.fn(),
}));

vi.mock("../../../services/DBServices.js", () => ({
  createDBServices: () => ({
    vacation: {
      getVacationsForUser: mockGetVacationsForUser,
      getVacationsForGroup: mockGetVacationsForGroup,
    },
    report: {
      getScopeEntries: mockGetScopeEntries,
    },
    group: {
      getGroupsWhereUserCanApprove: mockGetGroupsWhereUserCanApprove,
    },
    groupUser: {
      getGroupUser: mockGetGroupUser,
    },
    groupMirror: {
      hasMirrorIntoGroup: mockHasMirrorIntoGroup,
    },
  }),
}));

import { handleGetVacations } from "../handleGetVacations.js";
import { formatStartAndEndDate } from "../../../utils/dateFunc.js";
import { getAuth } from "../../../middleware/authSession.js";

const makeReqRes = (query: any = {}) => {
  const req = {
    query,
  } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
};

describe("handleGetVacations", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default mocks
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue({
      userId: "user_123",
      sessionId: "session_123",
      userName: "Test User",
      userEmail: "test@example.com",
      emailVerified: true,
    });

    (formatStartAndEndDate as ReturnType<typeof vi.fn>).mockReturnValue({
      startDate: "2024-01-01",
      endDate: "2024-01-31",
    });

    mockGetGroupsWhereUserCanApprove.mockResolvedValue([]);
    mockGetGroupUser.mockResolvedValue(undefined);
    mockHasMirrorIntoGroup.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes includeCancelled=true through so the requests view can show cancelled rows", async () => {
    const { req, res } = makeReqRes({ year: "2024", month: "3", includeCancelled: "true" });
    mockGetVacationsForUser.mockResolvedValue([]);

    await handleGetVacations(req, res);

    expect(mockGetVacationsForUser).toHaveBeenCalledWith("user_123", "2024-01-01", "2024-01-31", {
      includeCancelled: true,
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("should return vacations for the authenticated user with provided year and month", async () => {
    const { req, res } = makeReqRes({ year: "2024", month: "3" });
    const mockVacations = [
      {
        id: 1,
        userId: "user_123",
        startDate: "2024-03-01",
        endDate: "2024-03-05",
      },
      {
        id: 2,
        userId: "user_123",
        startDate: "2024-03-15",
        endDate: "2024-03-20",
      },
    ];
    mockGetVacationsForUser.mockResolvedValue(mockVacations);

    await handleGetVacations(req, res);

    expect(getAuth).toHaveBeenCalledWith(req);
    expect(formatStartAndEndDate).toHaveBeenCalledWith(2024, 3);
    expect(mockGetVacationsForUser).toHaveBeenCalledWith("user_123", "2024-01-01", "2024-01-31", {
      includeCancelled: false,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    // Own records carry the same mirror fields as group ones so the calendar
    // never has to branch on which scope produced the row.
    expect(res.json).toHaveBeenCalledWith(
      mockVacations.map((v) => ({
        ...v,
        mirroredFromGroupId: null,
        mirroredFromGroupName: null,
        canApprove: false,
      }))
    );
  });

  it("should use default year (current year) when year query param is not provided", async () => {
    const { req, res } = makeReqRes({ month: "5" });
    const currentYear = new Date().getFullYear();
    mockGetVacationsForUser.mockResolvedValue([]);

    await handleGetVacations(req, res);

    expect(formatStartAndEndDate).toHaveBeenCalledWith(currentYear, 5);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith([]);
  });

  it("should use default month (current month) when month query param is not provided", async () => {
    const { req, res } = makeReqRes({ year: "2024" });
    const currentMonth = new Date().getMonth() + 1;
    mockGetVacationsForUser.mockResolvedValue([]);

    await handleGetVacations(req, res);

    expect(formatStartAndEndDate).toHaveBeenCalledWith(2024, currentMonth);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith([]);
  });

  it("should use default year and month when no query params are provided", async () => {
    const { req, res } = makeReqRes({});
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;
    mockGetVacationsForUser.mockResolvedValue([]);

    await handleGetVacations(req, res);

    expect(formatStartAndEndDate).toHaveBeenCalledWith(currentYear, currentMonth);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("should parse year and month from string query parameters", async () => {
    const { req, res } = makeReqRes({ year: "2025", month: "12" });
    mockGetVacationsForUser.mockResolvedValue([]);

    await handleGetVacations(req, res);

    expect(formatStartAndEndDate).toHaveBeenCalledWith(2025, 12);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("should return empty array when user has no vacations", async () => {
    const { req, res } = makeReqRes({ year: "2024", month: "6" });
    mockGetVacationsForUser.mockResolvedValue([]);

    await handleGetVacations(req, res);

    expect(mockGetVacationsForUser).toHaveBeenCalledWith("user_123", "2024-01-01", "2024-01-31", {
      includeCancelled: false,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith([]);
  });

  it("should throw validation error for year below minimum (2023)", async () => {
    const { req, res } = makeReqRes({ year: "2022", month: "1" });

    await expect(handleGetVacations(req, res)).rejects.toThrow();
  });

  it("should throw validation error for year above maximum (2050)", async () => {
    const { req, res } = makeReqRes({ year: "2051", month: "1" });

    await expect(handleGetVacations(req, res)).rejects.toThrow();
  });

  it("should throw validation error for month below 1", async () => {
    const { req, res } = makeReqRes({ year: "2024", month: "0" });

    await expect(handleGetVacations(req, res)).rejects.toThrow();
  });

  it("should throw validation error for month above 12", async () => {
    const { req, res } = makeReqRes({ year: "2024", month: "13" });

    await expect(handleGetVacations(req, res)).rejects.toThrow();
  });

  it("should throw validation error for non-numeric year", async () => {
    const { req, res } = makeReqRes({ year: "invalid", month: "1" });

    await expect(handleGetVacations(req, res)).rejects.toThrow();
  });

  it("should throw validation error for non-numeric month", async () => {
    const { req, res } = makeReqRes({ year: "2024", month: "invalid" });

    await expect(handleGetVacations(req, res)).rejects.toThrow();
  });

  it("should handle database service errors", async () => {
    const { req, res } = makeReqRes({ year: "2024", month: "3" });
    const dbError = new Error("Database connection failed");
    mockGetVacationsForUser.mockRejectedValue(dbError);

    await expect(handleGetVacations(req, res)).rejects.toThrow("Database connection failed");
    expect(mockGetVacationsForUser).toHaveBeenCalled();
  });

  it("should use the correct userId from auth", async () => {
    const { req, res } = makeReqRes({ year: "2024", month: "1" });
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue({
      userId: "different_user_456",
      sessionId: "session_456",
      userName: "Different User",
      userEmail: "different@example.com",
      emailVerified: true,
    });
    mockGetVacationsForUser.mockResolvedValue([]);

    await handleGetVacations(req, res);

    expect(mockGetVacationsForUser).toHaveBeenCalledWith(
      "different_user_456",
      "2024-01-01",
      "2024-01-31",
      { includeCancelled: false }
    );
  });

  describe("group scope", () => {
    const scopeEntry = (access: "all" | "self") => ({
      groupId: "group_1",
      groupName: "Team A",
      access,
      canEditQuotas: false,
    });

    const pendingRow = (id: string, userId: string, groupId = "group_1") => ({
      id,
      userId,
      groupId,
      deletedAt: null,
      approvedAt: null,
      rejectedAt: null,
      mirroredFromGroupId: null,
      mirroredFromGroupName: null,
    });

    it("returns the group's records, mirrored ones included, when the caller may view it", async () => {
      const { req, res } = makeReqRes({ year: "2024", month: "3", groupId: "group_1" });
      const groupRows = [
        pendingRow("v1", "user_123"),
        {
          ...pendingRow("v2", "user_999"),
          mirroredFromGroupId: "group_2",
          mirroredFromGroupName: "Team B",
        },
      ];
      mockGetScopeEntries.mockResolvedValue([scopeEntry("all")]);
      mockGetVacationsForGroup.mockResolvedValue(groupRows);

      await handleGetVacations(req, res);

      expect(mockGetVacationsForGroup).toHaveBeenCalledWith(
        "group_1",
        "2024-01-01",
        "2024-01-31",
        null,
        {
          includeCancelled: false,
        }
      );
      expect(mockGetVacationsForUser).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        groupRows.map((row) => ({ ...row, canApprove: false }))
      );
    });

    it("marks someone else's pending request approvable for an approver", async () => {
      const { req, res } = makeReqRes({ year: "2024", month: "3", groupId: "group_1" });
      mockGetScopeEntries.mockResolvedValue([scopeEntry("all")]);
      mockGetVacationsForGroup.mockResolvedValue([pendingRow("v1", "user_999")]);
      mockGetGroupsWhereUserCanApprove.mockResolvedValue(["group_1"]);

      await handleGetVacations(req, res);

      expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ canApprove: true })]);
    });

    it("marks an approver's own request approvable only when nothing mirrors into the group", async () => {
      const { req, res } = makeReqRes({ year: "2024", month: "3", groupId: "group_1" });
      mockGetScopeEntries.mockResolvedValue([scopeEntry("all")]);
      mockGetVacationsForGroup.mockResolvedValue([pendingRow("v1", "user_123")]);
      mockGetGroupsWhereUserCanApprove.mockResolvedValue(["group_1"]);
      mockGetGroupUser.mockResolvedValue({ approverAccess: true });
      mockHasMirrorIntoGroup.mockResolvedValue(true);

      await handleGetVacations(req, res);

      expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ canApprove: false })]);

      mockHasMirrorIntoGroup.mockResolvedValue(false);
      const second = makeReqRes({ year: "2024", month: "3", groupId: "group_1" });
      await handleGetVacations(second.req, second.res);

      expect(second.res.json).toHaveBeenCalledWith([expect.objectContaining({ canApprove: true })]);
    });

    it("never marks a decided request approvable", async () => {
      const { req, res } = makeReqRes({ year: "2024", month: "3", groupId: "group_1" });
      mockGetScopeEntries.mockResolvedValue([scopeEntry("all")]);
      mockGetVacationsForGroup.mockResolvedValue([
        { ...pendingRow("v1", "user_999"), approvedAt: new Date() },
      ]);
      mockGetGroupsWhereUserCanApprove.mockResolvedValue(["group_1"]);

      await handleGetVacations(req, res);

      expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ canApprove: false })]);
    });

    it("rejects a member without view access on the group", async () => {
      const { req, res } = makeReqRes({ year: "2024", month: "3", groupId: "group_1" });
      mockGetScopeEntries.mockResolvedValue([scopeEntry("self")]);

      await expect(handleGetVacations(req, res)).rejects.toMatchObject({ code: 403 });
      expect(mockGetVacationsForGroup).not.toHaveBeenCalled();
    });

    it("rejects a group the caller does not belong to", async () => {
      const { req, res } = makeReqRes({ year: "2024", month: "3", groupId: "group_other" });
      mockGetScopeEntries.mockResolvedValue([scopeEntry("all")]);

      await expect(handleGetVacations(req, res)).rejects.toMatchObject({ code: 403 });
      expect(mockGetVacationsForGroup).not.toHaveBeenCalled();
    });
  });

  it("should pass correct date range from formatStartAndEndDate to service", async () => {
    const { req, res } = makeReqRes({ year: "2024", month: "7" });
    (formatStartAndEndDate as ReturnType<typeof vi.fn>).mockReturnValue({
      startDate: "2024-07-01",
      endDate: "2024-07-31",
    });
    mockGetVacationsForUser.mockResolvedValue([]);

    await handleGetVacations(req, res);

    expect(mockGetVacationsForUser).toHaveBeenCalledWith("user_123", "2024-07-01", "2024-07-31", {
      includeCancelled: false,
    });
  });
});

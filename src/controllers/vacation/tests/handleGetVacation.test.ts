import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetVacationDetailById,
  mockGetVacationEvents,
  mockGetGroupUser,
  mockGetGroupsWhereUserCanApprove,
} = vi.hoisted(() => ({
  mockGetVacationDetailById: vi.fn(),
  mockGetVacationEvents: vi.fn(),
  mockGetGroupUser: vi.fn(),
  mockGetGroupsWhereUserCanApprove: vi.fn(),
}));

vi.mock("../../../middleware/authSession.js", () => ({
  getAuth: vi.fn(),
}));

vi.mock("../../../services/DBServices.js", () => ({
  createDBServices: () => ({
    vacation: { getVacationDetailById: mockGetVacationDetailById },
    vacationEvent: { getVacationEvents: mockGetVacationEvents },
    groupUser: { getGroupUser: mockGetGroupUser },
    group: { getGroupsWhereUserCanApprove: mockGetGroupsWhereUserCanApprove },
  }),
}));

import { handleGetVacation } from "../handleGetVacation.js";
import { getAuth } from "../../../middleware/authSession.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";

const vacationId = "550e8400-e29b-41d4-a716-446655440000";
const groupId = "550e8400-e29b-41d4-a716-446655440009";

const detail = {
  id: vacationId,
  userId: mockAuthData.userId,
  groupId,
  requestedDay: "2026-08-12",
  deletedAt: null,
  approvedAt: null,
  rejectedAt: null,
  groupName: "Platform",
};

describe("handleGetVacation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthData);
    mockGetVacationEvents.mockResolvedValue([]);
  });

  it("returns the detail with history and the owner's permissions", async () => {
    const { req, res } = makeReqRes({ params: { id: vacationId } });

    mockGetVacationDetailById.mockResolvedValue(detail);
    mockGetGroupUser.mockResolvedValue({ viewAccess: true, adminAccess: false });
    mockGetGroupsWhereUserCanApprove.mockResolvedValue([]);
    mockGetVacationEvents.mockResolvedValue([{ id: "e-1", eventType: "CREATED" }]);

    await handleGetVacation(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        id: vacationId,
        canApprove: false,
        canCancel: true,
        history: [{ id: "e-1", eventType: "CREATED" }],
      })
    );
  });

  it("marks an approver as able to approve and cancel", async () => {
    const { req, res } = makeReqRes({ params: { id: vacationId } });

    mockGetVacationDetailById.mockResolvedValue({ ...detail, userId: "someone_else" });
    mockGetGroupUser.mockResolvedValue({ viewAccess: true, adminAccess: false });
    mockGetGroupsWhereUserCanApprove.mockResolvedValue([groupId]);

    await handleGetVacation(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ canApprove: true, canCancel: true })
    );
  });

  it("rejects a caller with no relationship to the group", async () => {
    const { req, res } = makeReqRes({ params: { id: vacationId } });

    mockGetVacationDetailById.mockResolvedValue({ ...detail, userId: "someone_else" });
    mockGetGroupUser.mockResolvedValue(undefined);
    mockGetGroupsWhereUserCanApprove.mockResolvedValue([]);

    await expect(handleGetVacation(req, res)).rejects.toThrow(
      "You are not allowed to view this vacation"
    );
  });

  it("404s for an unknown vacation", async () => {
    const { req, res } = makeReqRes({ params: { id: vacationId } });

    mockGetVacationDetailById.mockResolvedValue(undefined);

    await expect(handleGetVacation(req, res)).rejects.toThrow("Vacation not found");
  });
});

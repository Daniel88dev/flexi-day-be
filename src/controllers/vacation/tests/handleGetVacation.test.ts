import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetVacationDetailById,
  mockGetVacationEvents,
  mockGetGroupUser,
  mockGetGroupsWhereUserCanApprove,
  mockResolveGroupAdmin,
} = vi.hoisted(() => ({
  mockGetVacationDetailById: vi.fn(),
  mockGetVacationEvents: vi.fn(),
  mockGetGroupUser: vi.fn(),
  mockGetGroupsWhereUserCanApprove: vi.fn(),
  mockResolveGroupAdmin: vi.fn(),
}));

vi.mock("../../../services/groupUser/groupAccess.js", () => ({
  resolveGroupAdmin: mockResolveGroupAdmin,
}));

vi.mock("../../../middleware/authSession.js", () => ({
  getAuth: vi.fn(),
}));

vi.mock("../../../services/group/groupServices.js", () => ({
  getGroupsWhereUserCanApprove: mockGetGroupsWhereUserCanApprove,
}));

vi.mock("../../../services/groupUser/groupUserServices.js", () => ({
  getGroupUser: mockGetGroupUser,
}));

vi.mock("../../../services/vacation/vacationServices.js", () => ({
  getVacationDetailById: mockGetVacationDetailById,
}));

vi.mock("../../../services/vacationEvent/vacationEventServices.js", () => ({
  getVacationEvents: mockGetVacationEvents,
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
    mockResolveGroupAdmin.mockResolvedValue({ canAdmin: false, viaOrgAdmin: false });
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
        canEdit: false,
        history: [{ id: "e-1", eventType: "CREATED" }],
      })
    );
  });

  it("marks an org admin as able to view, cancel and edit but not approve", async () => {
    const { req, res } = makeReqRes({ params: { id: vacationId } });

    mockGetVacationDetailById.mockResolvedValue({ ...detail, userId: "someone_else" });
    mockGetGroupUser.mockResolvedValue(undefined);
    mockGetGroupsWhereUserCanApprove.mockResolvedValue([]);
    mockResolveGroupAdmin.mockResolvedValue({ canAdmin: true, viaOrgAdmin: true });

    await handleGetVacation(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ canApprove: false, canCancel: true, canEdit: true })
    );
  });

  it("reports a cancelled record as neither cancellable nor editable", async () => {
    const { req, res } = makeReqRes({ params: { id: vacationId } });

    mockGetVacationDetailById.mockResolvedValue({
      ...detail,
      userId: "someone_else",
      deletedAt: new Date("2026-08-01T00:00:00Z"),
    });
    mockGetGroupUser.mockResolvedValue(undefined);
    mockGetGroupsWhereUserCanApprove.mockResolvedValue([]);
    mockResolveGroupAdmin.mockResolvedValue({ canAdmin: true, viaOrgAdmin: false });

    await handleGetVacation(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ canApprove: false, canCancel: false, canEdit: false })
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

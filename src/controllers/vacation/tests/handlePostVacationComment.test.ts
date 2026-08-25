import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Billing plan-limit guards are no-ops here; their behavior has its own suite.
vi.mock("../../../services/billing/guards.js", () => ({
  assertCanCreateGroup: vi.fn(),
  assertCanAddMember: vi.fn(),
  assertGroupWritable: vi.fn(),
  assertGroupsWritable: vi.fn(),
}));

const { mockGetVacationById, mockCreateVacationEvent, mockResolvePermissions, mockNotifyComment } =
  vi.hoisted(() => ({
    mockGetVacationById: vi.fn(),
    mockCreateVacationEvent: vi.fn(),
    mockResolvePermissions: vi.fn(),
    mockNotifyComment: vi.fn(),
  }));

vi.mock("../../../middleware/authSession.js", () => ({
  getAuth: vi.fn(),
}));

vi.mock("../../../db/db.js", () => ({
  db: {
    transaction: vi.fn((callback) => callback({})),
  },
}));

vi.mock("../../../services/vacation/vacationServices.js", () => ({
  getVacationById: mockGetVacationById,
}));

vi.mock("../../../services/vacationEvent/vacationEventServices.js", () => ({
  createVacationEvent: mockCreateVacationEvent,
}));

vi.mock("../../../services/vacation/vacationPermissions.js", () => ({
  resolveVacationPermissions: mockResolvePermissions,
}));

vi.mock("../../../services/vacation/vacationNotifier.js", () => ({
  notifyVacationComment: mockNotifyComment,
}));

import { handlePostVacationComment } from "../handlePostVacationComment.js";
import { getAuth } from "../../../middleware/authSession.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";

const vacationId = "550e8400-e29b-41d4-a716-446655440000";
const vacationRow = {
  id: vacationId,
  userId: "vacation_owner_123",
  groupId: "group_123",
  requestedDay: "2026-03-15",
  vacationType: "Vacation",
};

describe("handlePostVacationComment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthData);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores a COMMENT event and notifies when the caller can view", async () => {
    const { req, res } = makeReqRes({
      params: { id: vacationId },
      body: { message: "Any update on this?" },
    });

    mockGetVacationById.mockResolvedValue(vacationRow);
    mockResolvePermissions.mockResolvedValue({
      canView: true,
      canApprove: false,
      canCancel: false,
    });

    await handlePostVacationComment(req, res);

    expect(mockCreateVacationEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        vacationId,
        eventType: "COMMENT",
        actorUserId: mockAuthData.userId,
        reason: "Any update on this?",
      }),
      {}
    );
    expect(mockNotifyComment).toHaveBeenCalledWith(
      vacationRow,
      { id: mockAuthData.userId, name: mockAuthData.userName },
      "Any update on this?"
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ message: "Comment added" });
  });

  it("throws 403 when the caller cannot view the vacation", async () => {
    const { req, res } = makeReqRes({
      params: { id: vacationId },
      body: { message: "hi" },
    });

    mockGetVacationById.mockResolvedValue(vacationRow);
    mockResolvePermissions.mockResolvedValue({
      canView: false,
      canApprove: false,
      canCancel: false,
    });

    await expect(handlePostVacationComment(req, res)).rejects.toThrow(
      "You are not allowed to comment on this vacation"
    );
    expect(mockCreateVacationEvent).not.toHaveBeenCalled();
    expect(mockNotifyComment).not.toHaveBeenCalled();
  });

  it("throws 404 when the vacation is not found", async () => {
    const { req, res } = makeReqRes({
      params: { id: vacationId },
      body: { message: "hi" },
    });

    mockGetVacationById.mockResolvedValue(null);

    await expect(handlePostVacationComment(req, res)).rejects.toThrow("Vacation not found");
    expect(mockResolvePermissions).not.toHaveBeenCalled();
    expect(mockCreateVacationEvent).not.toHaveBeenCalled();
  });

  it("throws on an invalid vacation id", async () => {
    const { req, res } = makeReqRes({
      params: { id: "not-a-uuid" },
      body: { message: "hi" },
    });

    await expect(handlePostVacationComment(req, res)).rejects.toThrow();
    expect(mockGetVacationById).not.toHaveBeenCalled();
  });
});

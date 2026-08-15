import { describe, it, expect, vi, beforeEach } from "vitest";

// Billing plan-limit guards are no-ops here; their behavior has its own suite.
vi.mock("../../../services/billing/guards.js", () => ({
  assertCanCreateGroup: vi.fn(),
  assertCanAddMember: vi.fn(),
  assertGroupWritable: vi.fn(),
  assertGroupsWritable: vi.fn(),
}));

const {
  mockGetVacationById,
  mockDeleteVacation,
  mockCreateVacationEvent,
  mockGetGroupUser,
  mockGetGroupsWhereUserCanApprove,
} = vi.hoisted(() => ({
  mockGetVacationById: vi.fn(),
  mockDeleteVacation: vi.fn(),
  mockCreateVacationEvent: vi.fn(),
  mockGetGroupUser: vi.fn(),
  mockGetGroupsWhereUserCanApprove: vi.fn(),
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
    vacation: {
      getVacationById: mockGetVacationById,
      deleteVacation: mockDeleteVacation,
    },
    vacationEvent: { createVacationEvent: mockCreateVacationEvent },
    groupUser: { getGroupUser: mockGetGroupUser },
    group: { getGroupsWhereUserCanApprove: mockGetGroupsWhereUserCanApprove },
  }),
}));

import { handleDeleteVacation } from "../handleDeleteVacation.js";
import { getAuth } from "../../../middleware/authSession.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";

const vacationId = "550e8400-e29b-41d4-a716-446655440000";
const groupId = "550e8400-e29b-41d4-a716-446655440009";

const ownedVacation = {
  id: vacationId,
  userId: mockAuthData.userId,
  groupId,
  deletedAt: null,
  approvedAt: new Date("2026-08-01T09:00:00Z"),
};

describe("handleDeleteVacation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthData);
    mockDeleteVacation.mockResolvedValue({ id: vacationId });
    mockGetGroupsWhereUserCanApprove.mockResolvedValue([]);
  });

  it("lets the owner cancel their own approved vacation and records the reason", async () => {
    const { req, res } = makeReqRes({
      params: { id: vacationId },
      body: { reason: "Trip called off" },
    });

    mockGetVacationById.mockResolvedValue(ownedVacation);
    mockGetGroupUser.mockResolvedValue({ viewAccess: true, adminAccess: false });

    await handleDeleteVacation(req, res);

    expect(mockDeleteVacation).toHaveBeenCalledWith(vacationId, expect.anything());
    expect(mockCreateVacationEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        vacationId,
        eventType: "CANCELLED",
        actorUserId: mockAuthData.userId,
        reason: "Trip called off",
      }),
      expect.anything()
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("lets a group approver cancel someone else's vacation", async () => {
    const { req, res } = makeReqRes({ params: { id: vacationId } });

    mockGetVacationById.mockResolvedValue({ ...ownedVacation, userId: "someone_else" });
    mockGetGroupUser.mockResolvedValue({ viewAccess: true, adminAccess: false });
    mockGetGroupsWhereUserCanApprove.mockResolvedValue([groupId]);

    await handleDeleteVacation(req, res);

    expect(mockDeleteVacation).toHaveBeenCalledWith(vacationId, expect.anything());
  });

  it("rejects a plain member cancelling someone else's vacation", async () => {
    const { req, res } = makeReqRes({ params: { id: vacationId } });

    mockGetVacationById.mockResolvedValue({ ...ownedVacation, userId: "someone_else" });
    mockGetGroupUser.mockResolvedValue({ viewAccess: true, adminAccess: false });

    await expect(handleDeleteVacation(req, res)).rejects.toThrow(
      "You are not allowed to cancel this vacation"
    );
    expect(mockDeleteVacation).not.toHaveBeenCalled();
  });
});

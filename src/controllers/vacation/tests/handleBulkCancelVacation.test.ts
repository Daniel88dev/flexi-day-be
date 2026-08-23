import { describe, it, expect, vi, beforeEach } from "vitest";

// Billing plan-limit guards are no-ops here; their behavior has its own suite.
vi.mock("../../../services/billing/guards.js", () => ({
  assertCanCreateGroup: vi.fn(),
  assertCanAddMember: vi.fn(),
  assertGroupWritable: vi.fn(),
  assertGroupsWritable: vi.fn(),
}));

const {
  mockGetVacationsByIds,
  mockCancelVacationsBulk,
  mockCreateVacationEvents,
  mockGetGroupsWhereUserCanApprove,
  mockGetGroupUser,
  mockNotifyVacationsCancelled,
  mockResolveGroupAdmin,
} = vi.hoisted(() => ({
  mockGetVacationsByIds: vi.fn(),
  mockCancelVacationsBulk: vi.fn(),
  mockCreateVacationEvents: vi.fn(),
  mockGetGroupsWhereUserCanApprove: vi.fn(),
  mockGetGroupUser: vi.fn(),
  mockNotifyVacationsCancelled: vi.fn(),
  mockResolveGroupAdmin: vi.fn(),
}));

vi.mock("../../../services/groupUser/groupAccess.js", () => ({
  resolveGroupAdmin: mockResolveGroupAdmin,
}));

vi.mock("../../../utils/generateUUID.js", () => ({
  generateRandomUUID: vi.fn(() => "uuid"),
}));

vi.mock("../../../middleware/authSession.js", () => ({
  getAuth: vi.fn(),
}));

vi.mock("../../../services/vacation/vacationNotifier.js", () => ({
  notifyVacationsCancelled: mockNotifyVacationsCancelled,
}));

vi.mock("../../../db/db.js", () => ({
  db: {
    transaction: vi.fn((callback: (tx: unknown) => unknown) => callback({})),
  },
}));

vi.mock("../../../services/DBServices.js", () => ({
  createDBServices: () => ({
    vacation: {
      getVacationsByIds: mockGetVacationsByIds,
      cancelVacationsBulk: mockCancelVacationsBulk,
    },
    vacationEvent: { createVacationEvents: mockCreateVacationEvents },
    group: { getGroupsWhereUserCanApprove: mockGetGroupsWhereUserCanApprove },
    groupUser: { getGroupUser: mockGetGroupUser },
  }),
}));

import { handleBulkCancelVacation } from "../handleBulkCancelVacation.js";
import { getAuth } from "../../../middleware/authSession.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";

const groupId = "550e8400-e29b-41d4-a716-446655440009";
const ownedRows = [
  { id: "v-1", userId: mockAuthData.userId, groupId, approvedAt: new Date() },
  { id: "v-2", userId: mockAuthData.userId, groupId, approvedAt: null },
];

describe("handleBulkCancelVacation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthData);
    mockGetGroupsWhereUserCanApprove.mockResolvedValue([]);
    mockGetGroupUser.mockResolvedValue(null);
    mockResolveGroupAdmin.mockResolvedValue({ canAdmin: false, viaOrgAdmin: false });
    mockCancelVacationsBulk.mockImplementation(async (ids: string[]) => ids.map((id) => ({ id })));
  });

  it("lets the owner cancel every day of their own request", async () => {
    const { req, res } = makeReqRes({ body: { ids: ["v-1", "v-2"], reason: "Plans changed" } });
    mockGetVacationsByIds.mockResolvedValue(ownedRows);

    await handleBulkCancelVacation(req, res);

    expect(mockCancelVacationsBulk).toHaveBeenCalledWith(
      ["v-1", "v-2"],
      mockAuthData.userId,
      expect.anything()
    );
    expect(mockCreateVacationEvents).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ eventType: "CANCELLED" })]),
      expect.anything()
    );
    expect(mockNotifyVacationsCancelled).toHaveBeenCalledWith(
      ownedRows,
      { id: mockAuthData.userId, name: mockAuthData.userName },
      "Plans changed"
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("lets a group approver cancel someone else's request", async () => {
    const othersRows = ownedRows.map((r) => ({ ...r, userId: "someone_else" }));
    const { req, res } = makeReqRes({ body: { ids: ["v-1", "v-2"] } });
    mockGetVacationsByIds.mockResolvedValue(othersRows);
    mockGetGroupsWhereUserCanApprove.mockResolvedValue([groupId]);

    await handleBulkCancelVacation(req, res);

    expect(mockCancelVacationsBulk).toHaveBeenCalledWith(
      ["v-1", "v-2"],
      mockAuthData.userId,
      expect.anything()
    );
  });

  it("lets an org admin cancel someone else's request", async () => {
    const othersRows = ownedRows.map((r) => ({ ...r, userId: "someone_else" }));
    const { req, res } = makeReqRes({ body: { ids: ["v-1", "v-2"] } });
    mockGetVacationsByIds.mockResolvedValue(othersRows);
    mockResolveGroupAdmin.mockResolvedValue({ canAdmin: true, viaOrgAdmin: true });

    await handleBulkCancelVacation(req, res);

    expect(mockCancelVacationsBulk).toHaveBeenCalledWith(
      ["v-1", "v-2"],
      mockAuthData.userId,
      expect.anything()
    );
  });

  it("rejects a plain member cancelling someone else's request", async () => {
    const othersRows = ownedRows.map((r) => ({ ...r, userId: "someone_else" }));
    const { req, res } = makeReqRes({ body: { ids: ["v-1", "v-2"] } });
    mockGetVacationsByIds.mockResolvedValue(othersRows);
    mockGetGroupUser.mockResolvedValue({ adminAccess: false });

    await expect(handleBulkCancelVacation(req, res)).rejects.toThrow(
      "You are not allowed to cancel one or more of these vacations"
    );
    expect(mockCancelVacationsBulk).not.toHaveBeenCalled();
  });

  it("404s when some ids no longer exist", async () => {
    const { req, res } = makeReqRes({ body: { ids: ["v-1", "v-2"] } });
    mockGetVacationsByIds.mockResolvedValue([ownedRows[0]]);

    await expect(handleBulkCancelVacation(req, res)).rejects.toThrow(
      "One or more vacations not found"
    );
    expect(mockCancelVacationsBulk).not.toHaveBeenCalled();
  });
});

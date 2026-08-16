import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Every other controller suite mocks the billing guards to no-ops, which means
 * deleting a guard call from a controller would leave the whole suite green and
 * silently drop plan enforcement from that route. This suite exists purely to
 * assert the wiring: that each guarded controller really does invoke its guard.
 */

const {
  mockAssertCanCreateGroup,
  mockAssertCanAddMember,
  mockAssertGroupWritable,
  mockAssertGroupsWritable,
} = vi.hoisted(() => ({
  mockAssertCanCreateGroup: vi.fn(),
  mockAssertCanAddMember: vi.fn(),
  mockAssertGroupWritable: vi.fn(),
  mockAssertGroupsWritable: vi.fn(),
}));

vi.mock("../../../services/billing/guards.js", () => ({
  assertCanCreateGroup: mockAssertCanCreateGroup,
  assertCanAddMember: mockAssertCanAddMember,
  assertGroupWritable: mockAssertGroupWritable,
  assertGroupsWritable: mockAssertGroupsWritable,
}));

const VACATION = {
  id: "vac-1",
  userId: "user-1",
  groupId: "group-1",
  approvedAt: null,
  rejectedAt: null,
  deletedAt: null,
};

const services = vi.hoisted(() => ({
  getVacationById: vi.fn(),
  createVacationEvent: vi.fn(),
  approveVacation: vi.fn(),
  deleteVacation: vi.fn(),
  createGroup: vi.fn(),
  createGroupUser: vi.fn(),
  openQuotaFromGroupDefaults: vi.fn(),
  ensureOrganizationForUser: vi.fn(),
  getGroupUser: vi.fn(),
  upsertUserYearQuota: vi.fn(),
  getUserYearGroupQuotas: vi.fn(),
  postChanges: vi.fn(),
}));

vi.mock("../../../services/DBServices.js", () => ({
  createDBServices: () => ({
    vacation: {
      getVacationById: services.getVacationById,
      approveVacation: services.approveVacation,
      deleteVacation: services.deleteVacation,
    },
    vacationEvent: { createVacationEvent: services.createVacationEvent },
    group: { createGroup: services.createGroup },
    groupUser: {
      createGroupUser: services.createGroupUser,
      getGroupUser: services.getGroupUser,
    },
    userYearQuotas: {
      openQuotaFromGroupDefaults: services.openQuotaFromGroupDefaults,
      upsertUserYearQuota: services.upsertUserYearQuota,
      getUserYearGroupQuotas: services.getUserYearGroupQuotas,
    },
    changes: { postChanges: services.postChanges },
    organization: { ensureOrganizationForUser: services.ensureOrganizationForUser },
  }),
}));

vi.mock("../../../db/db.js", () => ({
  db: { transaction: (cb: (tx: unknown) => unknown) => cb({}) },
}));

// `assertGroupAdmin` reaches for the service modules directly rather than
// through createDBServices, so both routes must resolve to the same mock.
vi.mock("../../../services/groupUser/groupUserServices.js", () => ({
  getGroupUser: services.getGroupUser,
  getAdminGroupIdsForUser: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../services/group/groupServices.js", () => ({
  getGroup: vi.fn().mockResolvedValue({ id: "group", organizationId: "org" }),
  getLiveGroupIdsForOrganizations: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../services/organization/organizationServices.js", () => ({
  isOrganizationAdmin: vi.fn().mockResolvedValue(false),
  getAdminOrganizationsForUser: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../middleware/authSession.js", () => ({
  getAuth: () => ({
    userId: "user-1",
    sessionId: "s-1",
    userName: "Olivia",
    userEmail: "olivia@dev.local",
    emailVerified: true,
  }),
}));

vi.mock("../../vacation/decisionGuards.js", () => ({
  assertMayDecide: vi.fn(),
  assertStillPending: vi.fn(),
  mayDecideOwn: vi.fn(),
}));

vi.mock("../../../services/vacation/quotaGuard.js", () => ({
  assertApprovalWithinQuota: vi.fn(),
  assertRequestWithinQuota: vi.fn(),
}));

vi.mock("../../../services/vacation/vacationNotifier.js", () => ({
  notifyVacationDecision: vi.fn(),
  notifyVacationCancelled: vi.fn(),
  notifyVacationRequested: vi.fn(),
}));

vi.mock("../../vacation/utils.js", () => ({
  resolveVacationPermissions: () => ({ canCancel: true, canView: true }),
}));

import { handlePostVacationApproval } from "../../vacation/handlePostVacationApproval.js";
import { handleDeleteVacation } from "../../vacation/handleDeleteVacation.js";
import { handlePostGroup } from "../../group/handlePostGroup.js";
import { handlePutUserQuota } from "../../quotas/handlePutUserQuota.js";
import { makeReqRes } from "../../../tests/testUtils.js";

describe("billing guard wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    services.getVacationById.mockResolvedValue(VACATION);
    services.approveVacation.mockResolvedValue({ ...VACATION, approvedAt: new Date() });
    services.deleteVacation.mockResolvedValue({ ...VACATION, deletedAt: new Date() });
    services.createVacationEvent.mockResolvedValue({ id: "ev-1" });
    services.ensureOrganizationForUser.mockResolvedValue({ id: "org-1" });
    services.createGroup.mockResolvedValue({
      id: "group-1",
      defaultVacationDays: 20,
      defaultHomeOfficeDays: 0,
    });
    services.createGroupUser.mockResolvedValue({ id: "gu-1" });
    services.getGroupUser.mockResolvedValue({ adminAccess: true });
    services.getUserYearGroupQuotas.mockResolvedValue([]);
    services.upsertUserYearQuota.mockResolvedValue({ id: "q-1" });
  });

  it("handlePostVacationApproval checks the group is writable", async () => {
    const { req, res } = makeReqRes({ params: { id: "3f1b1a2c-0000-4000-8000-000000000000" } });
    await handlePostVacationApproval(req, res);
    expect(mockAssertGroupWritable).toHaveBeenCalledWith("group-1", {});
  });

  it("handleDeleteVacation checks the group is writable", async () => {
    const { req, res } = makeReqRes({ params: { id: "3f1b1a2c-0000-4000-8000-000000000000" } });
    await handleDeleteVacation(req, res);
    expect(mockAssertGroupWritable).toHaveBeenCalledWith("group-1", {});
  });

  it("handlePostGroup checks the organization may create another group", async () => {
    const { req, res } = makeReqRes({ body: { groupName: "Platform" } });
    await handlePostGroup(req, res);
    expect(mockAssertCanCreateGroup).toHaveBeenCalledWith("org-1", {});
  });

  it("handlePutUserQuota checks the group is writable before touching the quota", async () => {
    const { req, res } = makeReqRes({
      params: { groupId: "3f1b1a2c-0000-4000-8000-000000000000" },
      body: { userId: "user-2", year: 2026, vacationDays: 20, homeOfficeDays: 5 },
    });
    services.getGroupUser.mockResolvedValue({ adminAccess: true });

    // The guard runs early, so what the handler does afterwards is irrelevant
    // to the wiring this asserts.
    await handlePutUserQuota(req, res).catch(() => undefined);

    expect(mockAssertGroupWritable).toHaveBeenCalledWith(
      "3f1b1a2c-0000-4000-8000-000000000000",
      {}
    );
  });
});

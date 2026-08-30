import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetGroup, mockGetGroupUser, mockIsOrganizationAdmin, mockResolveOrganizationBadges } =
  vi.hoisted(() => ({
    mockGetGroup: vi.fn(),
    mockGetGroupUser: vi.fn(),
    mockIsOrganizationAdmin: vi.fn(),
    mockResolveOrganizationBadges: vi.fn(),
  }));

vi.mock("../../../middleware/authSession.js", () => ({ getAuth: vi.fn() }));

vi.mock("../../../services/groupUser/groupUserServices.js", () => ({
  getGroupUser: mockGetGroupUser,
  getAdminGroupIdsForUser: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../services/group/groupServices.js", () => ({
  getGroup: mockGetGroup,
  getLiveGroupIdsForOrganizations: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../services/organization/organizationServices.js", () => ({
  isOrganizationAdmin: mockIsOrganizationAdmin,
  getAdminOrganizationsForUser: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../services/organization/organizationBadge.js", () => ({
  resolveOrganizationBadges: mockResolveOrganizationBadges,
}));

import { handleGetGroup } from "../handleGetGroup.js";
import { getAuth } from "../../../middleware/authSession.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";

const groupId = "550e8400-e29b-41d4-a716-446655440000";

const group = {
  id: groupId,
  organizationId: "org-1",
  groupName: "Engineering",
  managerUserId: "manager_1",
};

const badge = { id: "org-1", name: "Acme", plan: "PRO", status: "active", active: true };

describe("handleGetGroup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuth).mockReturnValue(mockAuthData);
    mockGetGroup.mockResolvedValue(group);
    mockIsOrganizationAdmin.mockResolvedValue(false);
    mockResolveOrganizationBadges.mockResolvedValue(new Map([["org-1", badge]]));
  });

  const call = async () => {
    const { req, res } = makeReqRes({ params: { groupId } });
    await handleGetGroup(req, res);
    return vi.mocked(res.json).mock.calls[0]?.[0] as {
      organization: unknown;
      access: { canView: boolean; canAdmin: boolean; viaOrgAdmin: boolean; isMember: boolean };
    };
  };

  it("404s for a group that does not exist", async () => {
    mockGetGroup.mockResolvedValue(undefined);
    const { req, res } = makeReqRes({ params: { groupId } });

    await expect(handleGetGroup(req, res)).rejects.toThrow("Group not found");
  });

  it("403s for someone with neither membership nor organization rights", async () => {
    mockGetGroupUser.mockResolvedValue(undefined);
    const { req, res } = makeReqRes({ params: { groupId } });

    await expect(handleGetGroup(req, res)).rejects.toThrow("No access for related group");
  });

  it("reports a plain member as a viewer, not an admin", async () => {
    mockGetGroupUser.mockResolvedValue({ viewAccess: true, adminAccess: false });

    expect((await call()).access).toEqual({
      canView: true,
      canAdmin: false,
      viaOrgAdmin: false,
      isMember: true,
    });
  });

  it("reports a group admin's rights as their own, not the organization's", async () => {
    mockGetGroupUser.mockResolvedValue({ viewAccess: true, adminAccess: true });

    expect((await call()).access).toEqual({
      canView: true,
      canAdmin: true,
      viaOrgAdmin: false,
      isMember: true,
    });
  });

  it("lets the group's manager in without a membership row", async () => {
    vi.mocked(getAuth).mockReturnValue({ ...mockAuthData, userId: "manager_1" });
    mockGetGroupUser.mockResolvedValue(undefined);

    expect((await call()).access).toEqual({
      canView: true,
      canAdmin: true,
      viaOrgAdmin: false,
      isMember: false,
    });
  });

  it("reports a manager who also holds a plain membership as a member", async () => {
    vi.mocked(getAuth).mockReturnValue({ ...mockAuthData, userId: "manager_1" });
    mockGetGroupUser.mockResolvedValue({ viewAccess: false, adminAccess: false });

    expect((await call()).access).toEqual({
      canView: true,
      canAdmin: true,
      viaOrgAdmin: false,
      isMember: true,
    });
  });

  it("lets an org admin in without a membership, flagged as org authority", async () => {
    mockGetGroupUser.mockResolvedValue(undefined);
    mockIsOrganizationAdmin.mockResolvedValue(true);

    expect((await call()).access).toEqual({
      canView: true,
      canAdmin: true,
      viaOrgAdmin: true,
      isMember: false,
    });
  });

  it("carries the organization badge", async () => {
    mockGetGroupUser.mockResolvedValue({ viewAccess: true, adminAccess: false });

    expect((await call()).organization).toEqual(badge);
  });
});

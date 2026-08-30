import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetGroupUser,
  mockGetAdminGroupIdsForUser,
  mockGetGroup,
  mockFilterGroupIdsByOrganization,
  mockGetLiveGroupIdsForOrganizations,
  mockGetManagedGroupIdsForUser,
  mockGetAdminOrganizationsForUser,
  mockIsOrganizationAdmin,
} = vi.hoisted(() => ({
  mockGetGroupUser: vi.fn(),
  mockGetAdminGroupIdsForUser: vi.fn(),
  mockGetGroup: vi.fn(),
  mockFilterGroupIdsByOrganization: vi.fn(),
  mockGetLiveGroupIdsForOrganizations: vi.fn(),
  mockGetManagedGroupIdsForUser: vi.fn(),
  mockGetAdminOrganizationsForUser: vi.fn(),
  mockIsOrganizationAdmin: vi.fn(),
}));

vi.mock("../groupUserServices.js", () => ({
  getGroupUser: mockGetGroupUser,
  getAdminGroupIdsForUser: mockGetAdminGroupIdsForUser,
}));

vi.mock("../../group/groupServices.js", () => ({
  getGroup: mockGetGroup,
  filterGroupIdsByOrganization: mockFilterGroupIdsByOrganization,
  getLiveGroupIdsForOrganizations: mockGetLiveGroupIdsForOrganizations,
  getManagedGroupIdsForUser: mockGetManagedGroupIdsForUser,
}));

vi.mock("../../organization/organizationServices.js", () => ({
  getAdminOrganizationsForUser: mockGetAdminOrganizationsForUser,
  isOrganizationAdmin: mockIsOrganizationAdmin,
}));

import {
  assertGroupAdmin,
  getAdministrableGroupIds,
  resolveGroupAccess,
  resolveGroupAdmin,
  validateUserGroupAccess,
} from "../groupAccess.js";

const managerId = "manager_1";
const strangerId = "stranger_1";
const group = { id: "group-1", organizationId: "org-1", managerUserId: managerId };

describe("groupAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGroupUser.mockResolvedValue(undefined);
    mockGetGroup.mockResolvedValue(group);
    mockIsOrganizationAdmin.mockResolvedValue(false);
    mockGetAdminOrganizationsForUser.mockResolvedValue([]);
    mockGetLiveGroupIdsForOrganizations.mockResolvedValue([]);
    mockGetAdminGroupIdsForUser.mockResolvedValue([]);
    mockGetManagedGroupIdsForUser.mockResolvedValue([]);
    mockFilterGroupIdsByOrganization.mockImplementation(
      async (groupIds: string[], organizationId: string) =>
        organizationId === "org-1" ? groupIds : []
    );
  });

  describe("resolveGroupAccess", () => {
    it("grants the manager view and admin without a membership row", async () => {
      expect(await resolveGroupAccess(managerId, group)).toEqual({
        canView: true,
        canAdmin: true,
        viaOrgAdmin: false,
        isMember: false,
      });
    });

    it("keeps a manager with a plain membership row a member", async () => {
      mockGetGroupUser.mockResolvedValue({ viewAccess: false, adminAccess: false });

      expect(await resolveGroupAccess(managerId, group)).toEqual({
        canView: true,
        canAdmin: true,
        viaOrgAdmin: false,
        isMember: true,
      });
    });

    it("still shuts out someone with no standing at all", async () => {
      expect(await resolveGroupAccess(strangerId, group)).toEqual({
        canView: false,
        canAdmin: false,
        viaOrgAdmin: false,
        isMember: false,
      });
    });
  });

  describe("resolveGroupAdmin", () => {
    it("grants the manager admin as their own authority", async () => {
      expect(await resolveGroupAdmin(managerId, group.id)).toEqual({
        canAdmin: true,
        viaOrgAdmin: false,
      });
    });

    it("flags an org admin's authority as the organization's", async () => {
      mockIsOrganizationAdmin.mockResolvedValue(true);

      expect(await resolveGroupAdmin(strangerId, group.id)).toEqual({
        canAdmin: true,
        viaOrgAdmin: true,
      });
    });

    it("denies when the group does not exist", async () => {
      mockGetGroup.mockResolvedValue(undefined);

      expect(await resolveGroupAdmin(managerId, group.id)).toEqual({
        canAdmin: false,
        viaOrgAdmin: false,
      });
    });
  });

  describe("validateUserGroupAccess", () => {
    it("accepts the manager without a membership row", async () => {
      expect(await validateUserGroupAccess(managerId, group.id)).toBe(true);
    });

    it("rejects someone with no standing", async () => {
      expect(await validateUserGroupAccess(strangerId, group.id)).toBe(false);
    });
  });

  describe("assertGroupAdmin", () => {
    it("passes for the manager", async () => {
      await expect(assertGroupAdmin(managerId, group.id)).resolves.toBeUndefined();
    });

    it("throws 403 for someone with no standing", async () => {
      await expect(assertGroupAdmin(strangerId, group.id)).rejects.toThrow(
        "No permission for related group"
      );
    });
  });

  describe("getAdministrableGroupIds", () => {
    it("includes groups the caller manages", async () => {
      mockGetManagedGroupIdsForUser.mockResolvedValue(["group-1"]);

      expect(await getAdministrableGroupIds(managerId)).toEqual(["group-1"]);
    });

    it("keeps managed groups out of a scope naming another organization", async () => {
      mockGetManagedGroupIdsForUser.mockResolvedValue(["group-1"]);

      expect(await getAdministrableGroupIds(managerId, { organizationId: "org-2" })).toEqual([]);
    });

    it("deduplicates a managed group that is also org-administered", async () => {
      mockGetManagedGroupIdsForUser.mockResolvedValue(["group-1"]);
      mockGetAdminOrganizationsForUser.mockResolvedValue([{ id: "org-1" }]);
      mockGetLiveGroupIdsForOrganizations.mockResolvedValue(["group-1", "group-2"]);

      expect((await getAdministrableGroupIds(managerId)).sort()).toEqual(["group-1", "group-2"]);
    });
  });
});

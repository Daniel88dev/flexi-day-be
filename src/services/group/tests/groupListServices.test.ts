import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetAdministrableGroupIds,
  mockGetAllGroupsForUser,
  mockCountMembersByGroup,
  mockGetAllGroups,
  mockResolveOrganizationBadges,
  mockIsAttachmentUploadAvailable,
} = vi.hoisted(() => ({
  mockGetAdministrableGroupIds: vi.fn(),
  mockGetAllGroupsForUser: vi.fn(),
  mockCountMembersByGroup: vi.fn(),
  mockGetAllGroups: vi.fn(),
  mockResolveOrganizationBadges: vi.fn(),
  mockIsAttachmentUploadAvailable: vi.fn(),
}));

vi.mock("../../groupUser/groupAccess.js", () => ({
  getAdministrableGroupIds: mockGetAdministrableGroupIds,
}));

vi.mock("../../groupUser/groupUserServices.js", () => ({
  getAllGroupsForUser: mockGetAllGroupsForUser,
  countMembersByGroup: mockCountMembersByGroup,
}));

vi.mock("../groupServices.js", () => ({
  getAllGroups: mockGetAllGroups,
}));

vi.mock("../../organization/organizationBadge.js", () => ({
  resolveOrganizationBadges: mockResolveOrganizationBadges,
}));

vi.mock("../../billing/guards.js", () => ({
  isAttachmentUploadAvailable: mockIsAttachmentUploadAvailable,
}));

import { getAdministeredGroups } from "../groupListServices.js";

const viewerId = "viewer_1";
const badge = { id: "org-1", name: "Acme", plan: "PRO", status: "active", active: true };

const group = (id: string, organizationId: string, managerUserId: string) => ({
  id,
  organizationId,
  groupName: id,
  managerUserId,
});

describe("getAdministeredGroups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAdministrableGroupIds.mockResolvedValue(["managed", "org-group", "member-group"]);
    mockGetAllGroupsForUser.mockResolvedValue([
      { groupId: "member-group", adminAccess: true, approverAccess: true },
    ]);
    mockGetAllGroups.mockResolvedValue([
      group("managed", "org-1", viewerId),
      group("org-group", "org-2", "someone_else"),
    ]);
    mockCountMembersByGroup.mockResolvedValue(new Map([["org-group", 3]]));
    mockResolveOrganizationBadges.mockResolvedValue(new Map([["org-1", badge]]));
    mockIsAttachmentUploadAvailable.mockImplementation((id: string) =>
      Promise.resolve(id === "org-1")
    );
  });

  it("leaves out every group the viewer holds a live membership in", async () => {
    await getAdministeredGroups(viewerId);

    expect(mockGetAdministrableGroupIds).toHaveBeenCalledWith(viewerId);
    expect(mockGetAllGroups).toHaveBeenCalledWith(["managed", "org-group"]);
  });

  it("returns the groups in the order the live-group read gives them", async () => {
    const result = await getAdministeredGroups(viewerId);

    expect(result.map((item) => item.id)).toEqual(["managed", "org-group"]);
  });

  it("flags organization authority unless the viewer manages the group", async () => {
    const [managed, orgGroup] = await getAdministeredGroups(viewerId);

    expect(managed?.viaOrgAdmin).toBe(false);
    expect(orgGroup?.viaOrgAdmin).toBe(true);
  });

  it("shapes each item like a GET /api/group item with no membership rights", async () => {
    const [managed, orgGroup] = await getAdministeredGroups(viewerId);

    expect(managed).toMatchObject({
      organization: badge,
      memberCount: 0,
      uploadsAvailable: true,
      membership: { adminAccess: false, approverAccess: false },
    });
    expect(orgGroup).toMatchObject({
      organization: null,
      memberCount: 3,
      uploadsAvailable: false,
      membership: { adminAccess: false, approverAccess: false },
    });
  });

  it("answers an empty list when the viewer administers nothing beyond their memberships", async () => {
    mockGetAdministrableGroupIds.mockResolvedValue(["member-group"]);
    mockGetAllGroups.mockResolvedValue([]);

    expect(await getAdministeredGroups(viewerId)).toEqual([]);
    expect(mockGetAllGroups).toHaveBeenCalledWith([]);
  });
});

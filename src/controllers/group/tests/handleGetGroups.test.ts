import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetAllGroupsForUser,
  mockGetAllGroups,
  mockCountMembersByGroup,
  mockResolveOrganizationBadges,
} = vi.hoisted(() => ({
  mockGetAllGroupsForUser: vi.fn(),
  mockGetAllGroups: vi.fn(),
  mockCountMembersByGroup: vi.fn(),
  mockResolveOrganizationBadges: vi.fn(),
}));

vi.mock("../../../middleware/authSession.js", () => ({ getAuth: vi.fn() }));

vi.mock("../../../services/organization/organizationBadge.js", () => ({
  resolveOrganizationBadges: mockResolveOrganizationBadges,
}));

vi.mock("../../../services/DBServices.js", () => ({
  createDBServices: () => ({
    group: { getAllGroups: mockGetAllGroups },
    groupUser: {
      getAllGroupsForUser: mockGetAllGroupsForUser,
      countMembersByGroup: mockCountMembersByGroup,
    },
  }),
}));

import { handleGetGroups } from "../handleGetGroups.js";
import { getAuth } from "../../../middleware/authSession.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";

const groupA = { id: "group-a", organizationId: "org-1", groupName: "Alpha" };
const groupB = { id: "group-b", organizationId: "org-2", groupName: "Beta" };

const badge = { id: "org-1", name: "Acme", plan: "PRO", status: "active", active: true };

describe("handleGetGroups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuth).mockReturnValue(mockAuthData);
    mockGetAllGroupsForUser.mockResolvedValue([
      { groupId: "group-a", adminAccess: true, approverAccess: false },
      { groupId: "group-b", adminAccess: false, approverAccess: true },
    ]);
    mockGetAllGroups.mockResolvedValue([groupA, groupB]);
    mockCountMembersByGroup.mockResolvedValue(
      new Map([
        ["group-a", 4],
        ["group-b", 1],
      ])
    );
    mockResolveOrganizationBadges.mockResolvedValue(new Map([["org-1", badge]]));
  });

  const call = async () => {
    const { req, res } = makeReqRes({});
    await handleGetGroups(req, res);
    return vi.mocked(res.json).mock.calls[0]?.[0] as {
      id: string;
      organization: unknown;
      memberCount: number;
      membership: { adminAccess: boolean; approverAccess: boolean };
    }[];
  };

  it("carries the member count per group", async () => {
    const result = await call();

    expect(result.map((g) => g.memberCount)).toEqual([4, 1]);
  });

  it("carries the caller's own membership flags per group", async () => {
    const [first, second] = await call();

    expect(first?.membership).toEqual({ adminAccess: true, approverAccess: false });
    expect(second?.membership).toEqual({ adminAccess: false, approverAccess: true });
  });

  it("falls back to zero members and no rights when the maps miss a group", async () => {
    mockCountMembersByGroup.mockResolvedValue(new Map());
    mockGetAllGroupsForUser.mockResolvedValue([
      { groupId: "group-a", adminAccess: true, approverAccess: false },
    ]);
    mockGetAllGroups.mockResolvedValue([groupA, groupB]);

    const [, second] = await call();

    expect(second?.memberCount).toBe(0);
    expect(second?.membership).toEqual({ adminAccess: false, approverAccess: false });
  });

  it("resolves the organization badge, null when the org has none", async () => {
    const [first, second] = await call();

    expect(first?.organization).toEqual(badge);
    expect(second?.organization).toBeNull();
  });
});

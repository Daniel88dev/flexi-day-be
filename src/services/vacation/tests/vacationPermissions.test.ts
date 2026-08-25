import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetGroupsWhereUserCanApprove,
  mockGetGroupUser,
  mockResolveGroupAdmin,
  mockMayDecideOwn,
} = vi.hoisted(() => ({
  mockGetGroupsWhereUserCanApprove: vi.fn(),
  mockGetGroupUser: vi.fn(),
  mockResolveGroupAdmin: vi.fn(),
  mockMayDecideOwn: vi.fn(),
}));

vi.mock("../../group/groupServices.js", () => ({
  getGroupsWhereUserCanApprove: mockGetGroupsWhereUserCanApprove,
}));

vi.mock("../../groupUser/groupUserServices.js", () => ({
  getGroupUser: mockGetGroupUser,
}));

vi.mock("../../groupUser/groupAccess.js", () => ({
  resolveGroupAdmin: mockResolveGroupAdmin,
}));

vi.mock("../decisionGuards.js", () => ({
  mayDecideOwn: mockMayDecideOwn,
}));

import {
  resolveCanApproveForList,
  resolveCanCancelForList,
  resolveVacationPermissions,
} from "../vacationPermissions.js";

const userId = "hUdX9mKq4LpR2wZn7tBvC3sYeA6gJfN1";
const groupId = "550e8400-e29b-41d4-a716-446655440009";

const liveRow = {
  userId,
  groupId,
  deletedAt: null,
  approvedAt: null,
  rejectedAt: null,
};

// A stamp that is missing rather than null, as a hand-built row or a mocked
// service produces. A strict `!== null` test reads it as cancelled.
const stampless = { userId, groupId, approvedAt: null, rejectedAt: null } as typeof liveRow;

describe("vacationPermissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGroupsWhereUserCanApprove.mockResolvedValue([]);
    mockGetGroupUser.mockResolvedValue(null);
    mockResolveGroupAdmin.mockResolvedValue({ canAdmin: false, viaOrgAdmin: false });
    mockMayDecideOwn.mockResolvedValue(false);
  });

  describe("resolveVacationPermissions", () => {
    it("reads an absent soft-delete stamp as live", async () => {
      const permissions = await resolveVacationPermissions(userId, stampless);

      expect(permissions.canCancel).toBe(true);
    });

    it("still refuses to cancel a row carrying a soft-delete stamp", async () => {
      const cancelled = { ...liveRow, deletedAt: new Date("2026-08-01T00:00:00Z") };

      const permissions = await resolveVacationPermissions(userId, cancelled);

      expect(permissions.canCancel).toBe(false);
    });

    it("lets an admin edit a row with an absent stamp", async () => {
      mockResolveGroupAdmin.mockResolvedValue({ canAdmin: true, viaOrgAdmin: false });

      const permissions = await resolveVacationPermissions("someone_else", stampless);

      expect(permissions.canEdit).toBe(true);
    });
  });

  describe("resolveCanApproveForList", () => {
    it("reads an absent soft-delete stamp as live", async () => {
      mockGetGroupsWhereUserCanApprove.mockResolvedValue([groupId]);
      mockMayDecideOwn.mockResolvedValue(true);

      const canApprove = await resolveCanApproveForList(userId, [stampless]);

      expect(canApprove(stampless)).toBe(true);
    });

    it("still refuses to approve a row carrying a soft-delete stamp", async () => {
      mockGetGroupsWhereUserCanApprove.mockResolvedValue([groupId]);
      mockMayDecideOwn.mockResolvedValue(true);
      const cancelled = { ...liveRow, deletedAt: new Date("2026-08-01T00:00:00Z") };

      const canApprove = await resolveCanApproveForList(userId, [cancelled]);

      expect(canApprove(cancelled)).toBe(false);
    });
  });

  describe("resolveCanCancelForList", () => {
    // The set-based verdict is a second implementation of `canCancel`, so the
    // two are pinned against each other. Only live rows: the row type is what
    // keeps a cancelled one out, and it cannot be written here.
    const standings = [
      { name: "the owner", actor: userId, approvable: [], canAdmin: false },
      { name: "an approver", actor: "someone_else", approvable: [groupId], canAdmin: false },
      { name: "a group admin", actor: "someone_else", approvable: [], canAdmin: true },
      { name: "an outsider", actor: "someone_else", approvable: [], canAdmin: false },
    ];

    it.each(standings)("agrees with the per-record resolver for $name", async (standing) => {
      mockGetGroupsWhereUserCanApprove.mockResolvedValue(standing.approvable);
      mockResolveGroupAdmin.mockResolvedValue({
        canAdmin: standing.canAdmin,
        viaOrgAdmin: false,
      });

      const canCancel = await resolveCanCancelForList(standing.actor, [liveRow]);
      const permissions = await resolveVacationPermissions(standing.actor, liveRow);

      expect(canCancel(liveRow)).toBe(permissions.canCancel);
    });

    it("lets the owner cancel, so the pin above is not agreeing on false", async () => {
      const canCancel = await resolveCanCancelForList(userId, [liveRow]);

      expect(canCancel(liveRow)).toBe(true);
    });
  });
});

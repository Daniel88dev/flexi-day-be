import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetGroupsWhereUserCanApprove,
  mockGetGroupUser,
  mockResolveGroupAdmin,
  mockMayDecideOwn,
  mockGetProjectingMirrorTargetGroupIds,
  mockGetReportScopeEntries,
} = vi.hoisted(() => ({
  mockGetGroupsWhereUserCanApprove: vi.fn(),
  mockGetGroupUser: vi.fn(),
  mockResolveGroupAdmin: vi.fn(),
  mockMayDecideOwn: vi.fn(),
  mockGetProjectingMirrorTargetGroupIds: vi.fn(),
  mockGetReportScopeEntries: vi.fn(),
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

vi.mock("../../groupMirror/groupMirrorServices.js", () => ({
  getProjectingMirrorTargetGroupIds: mockGetProjectingMirrorTargetGroupIds,
}));

vi.mock("../../report/reportServices.js", () => ({
  getReportScopeEntries: mockGetReportScopeEntries,
}));

import {
  resolveCanApproveForList,
  resolveCanCancelForList,
  resolvePrivilegedGroupIds,
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
    mockGetProjectingMirrorTargetGroupIds.mockResolvedValue([]);
    mockGetReportScopeEntries.mockResolvedValue([]);
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

  describe("a row mirrored into another group", () => {
    const targetGroupId = "550e8400-e29b-41d4-a716-446655440010";
    const scopeEntry = (access: "all" | "self") => ({
      groupId: targetGroupId,
      groupName: "Target",
      access,
      canEditQuotas: false,
    });

    it("may be seen, and nothing more, by someone who sees the target group in full", async () => {
      mockGetProjectingMirrorTargetGroupIds.mockResolvedValue([targetGroupId]);
      mockGetReportScopeEntries.mockResolvedValue([scopeEntry("all")]);

      const permissions = await resolveVacationPermissions("someone_else", liveRow);

      expect(mockGetProjectingMirrorTargetGroupIds).toHaveBeenCalledWith(
        userId,
        groupId,
        undefined
      );
      expect(permissions).toEqual({
        canView: true,
        canApprove: false,
        canCancel: false,
        canEdit: false,
        canReadPrivateDetails: false,
        canViewAttachments: false,
        canAttach: false,
        canDeleteAnyAttachment: false,
      });
    });

    it("stays hidden from someone who sees only their own rows in the target group", async () => {
      mockGetProjectingMirrorTargetGroupIds.mockResolvedValue([targetGroupId]);
      mockGetReportScopeEntries.mockResolvedValue([scopeEntry("self")]);

      const permissions = await resolveVacationPermissions("someone_else", liveRow);

      expect(permissions.canView).toBe(false);
    });

    it("skips the scope lookup when no mirror projects the row", async () => {
      const permissions = await resolveVacationPermissions("someone_else", liveRow);

      expect(permissions.canView).toBe(false);
      expect(mockGetReportScopeEntries).not.toHaveBeenCalled();
    });

    it("skips the mirror lookup for a caller with standing in the row's own group", async () => {
      mockGetGroupUser.mockResolvedValue({ viewAccess: true, adminAccess: false });

      await resolveVacationPermissions("someone_else", liveRow);

      expect(mockGetProjectingMirrorTargetGroupIds).not.toHaveBeenCalled();
    });
  });

  describe("attachment permissions", () => {
    it("lets the owner see and add attachments while the record is live and undecided against", async () => {
      const live = await resolveVacationPermissions(userId, liveRow);
      const cancelled = await resolveVacationPermissions(userId, {
        ...liveRow,
        deletedAt: new Date("2026-08-01T00:00:00Z"),
      });

      expect(live).toMatchObject({ canViewAttachments: true, canAttach: true });
      expect(cancelled).toMatchObject({ canViewAttachments: true, canAttach: false });
    });

    it("lets an approver see attachments but not add them", async () => {
      mockGetGroupsWhereUserCanApprove.mockResolvedValue([groupId]);

      const permissions = await resolveVacationPermissions("someone_else", liveRow);

      expect(permissions).toMatchObject({ canViewAttachments: true, canAttach: false });
    });

    it("lets an admin see and add attachments while the record is editable", async () => {
      mockResolveGroupAdmin.mockResolvedValue({ canAdmin: true, viaOrgAdmin: false });

      const live = await resolveVacationPermissions("someone_else", liveRow);
      const rejected = await resolveVacationPermissions("someone_else", {
        ...liveRow,
        rejectedAt: new Date("2026-08-01T00:00:00Z"),
      });

      expect(live).toMatchObject({ canViewAttachments: true, canAttach: true });
      expect(rejected).toMatchObject({ canViewAttachments: true, canAttach: false });
    });

    it("keeps a view-only member away from attachments", async () => {
      mockGetGroupUser.mockResolvedValue({ viewAccess: true, adminAccess: false });

      const permissions = await resolveVacationPermissions("someone_else", liveRow);

      expect(permissions.canView).toBe(true);
      expect(permissions).toMatchObject({ canViewAttachments: false, canAttach: false });
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

  describe("private details", () => {
    const standings = [
      {
        name: "the owner",
        actor: userId,
        approvable: [],
        canAdmin: false,
        view: false,
        read: true,
      },
      {
        name: "an approver",
        actor: "someone_else",
        approvable: [groupId],
        canAdmin: false,
        view: false,
        read: true,
      },
      {
        name: "a group admin",
        actor: "someone_else",
        approvable: [],
        canAdmin: true,
        view: false,
        read: true,
      },
      {
        name: "a view-only member",
        actor: "someone_else",
        approvable: [],
        canAdmin: false,
        view: true,
        read: false,
      },
    ];

    it.each(standings)("$name: canReadPrivateDetails is $read", async (standing) => {
      mockGetGroupsWhereUserCanApprove.mockResolvedValue(standing.approvable);
      mockResolveGroupAdmin.mockResolvedValue({ canAdmin: standing.canAdmin, viaOrgAdmin: false });
      mockGetGroupUser.mockResolvedValue(
        standing.view ? { viewAccess: true, adminAccess: false } : null
      );

      const permissions = await resolveVacationPermissions(standing.actor, liveRow);
      const privileged = await resolvePrivilegedGroupIds(standing.actor, [groupId]);

      expect(permissions.canReadPrivateDetails).toBe(standing.read);
      expect(standing.actor === userId || privileged.has(groupId)).toBe(standing.read);
    });

    it("resolves the privileged groups among those asked about, approver or admin", async () => {
      const approved = "550e8400-e29b-41d4-a716-446655440010";
      const administered = "550e8400-e29b-41d4-a716-446655440011";
      const neither = "550e8400-e29b-41d4-a716-446655440012";
      mockGetGroupsWhereUserCanApprove.mockResolvedValue([approved]);
      mockResolveGroupAdmin.mockImplementation(async (_user: string, group: string) => ({
        canAdmin: group === administered,
        viaOrgAdmin: false,
      }));

      const privileged = await resolvePrivilegedGroupIds("someone_else", [
        approved,
        administered,
        neither,
      ]);

      expect([...privileged].sort()).toEqual([approved, administered].sort());
    });
  });
});

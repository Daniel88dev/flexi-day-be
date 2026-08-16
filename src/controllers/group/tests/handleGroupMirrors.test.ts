import { describe, it, expect, vi, beforeEach } from "vitest";

// Billing plan-limit guards are no-ops here; their behavior has its own suite.
vi.mock("../../../services/billing/guards.js", () => ({
  assertCanCreateGroup: vi.fn(),
  assertCanAddMember: vi.fn(),
  assertGroupWritable: vi.fn(),
  assertGroupsWritable: vi.fn(),
}));

const {
  mockGetGroupUser,
  mockGetGroupUsers,
  mockGetAdminGroupIdsForUser,
  mockGetMembershipPairs,
  mockGetAllGroups,
  mockGetMirrorsIntoGroupForUser,
  mockGetMirrorsIntoGroupForUsers,
  mockSetMirrorsIntoGroupForUser,
} = vi.hoisted(() => ({
  mockGetGroupUser: vi.fn(),
  mockGetGroupUsers: vi.fn(),
  mockGetAdminGroupIdsForUser: vi.fn(),
  mockGetMembershipPairs: vi.fn(),
  mockGetAllGroups: vi.fn(),
  mockGetMirrorsIntoGroupForUser: vi.fn(),
  mockGetMirrorsIntoGroupForUsers: vi.fn(),
  mockSetMirrorsIntoGroupForUser: vi.fn(),
}));

vi.mock("../../../middleware/authSession.js", () => ({ getAuth: vi.fn() }));

vi.mock("../../../db/db.js", () => ({
  db: { transaction: vi.fn((callback) => callback({})) },
}));

vi.mock("../../../services/DBServices.js", () => ({
  createDBServices: () => ({
    groupUser: {
      getGroupUser: mockGetGroupUser,
      getGroupUsers: mockGetGroupUsers,
      getAdminGroupIdsForUser: mockGetAdminGroupIdsForUser,
      getMembershipPairs: mockGetMembershipPairs,
    },
    group: { getAllGroups: mockGetAllGroups },
    groupMirror: {
      getMirrorsIntoGroupForUser: mockGetMirrorsIntoGroupForUser,
      getMirrorsIntoGroupForUsers: mockGetMirrorsIntoGroupForUsers,
      setMirrorsIntoGroupForUser: mockSetMirrorsIntoGroupForUser,
    },
  }),
}));

import { handleGetGroupMirrors } from "../handleGetGroupMirrors.js";
import { handlePutGroupMirrors } from "../handlePutGroupMirrors.js";
import { getAuth } from "../../../middleware/authSession.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";

const TARGET = "550e8400-e29b-41d4-a716-446655440000";
const SOURCE_A = "550e8400-e29b-41d4-a716-446655440001";
const SOURCE_B = "550e8400-e29b-41d4-a716-446655440002";
const UNMANAGED = "550e8400-e29b-41d4-a716-446655440008";
const OUTSIDER = "550e8400-e29b-41d4-a716-446655440009";

const MEMBER = "member-1";

const memberRow = (userId: string, name: string) => ({
  userId,
  user: { id: userId, name, initials: "XX", avatarColor: "hsl(1, 65%, 50%)" },
  email: `${userId}@example.com`,
});

describe("handleGetGroupMirrors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthData);
    mockGetGroupUser.mockResolvedValue({ viewAccess: true, adminAccess: true });
    mockGetGroupUsers.mockResolvedValue([memberRow(MEMBER, "Ada Byron")]);
    mockGetAdminGroupIdsForUser.mockResolvedValue([TARGET, SOURCE_A, SOURCE_B]);
    mockGetMembershipPairs.mockResolvedValue([
      { userId: MEMBER, groupId: SOURCE_A },
      { userId: MEMBER, groupId: SOURCE_B },
    ]);
    mockGetAllGroups.mockResolvedValue([
      { id: SOURCE_A, groupName: "Team A" },
      { id: SOURCE_B, groupName: "Leadership" },
    ]);
    mockGetMirrorsIntoGroupForUsers.mockResolvedValue([
      { userId: MEMBER, sourceGroupId: SOURCE_A, sourceGroupName: "Team A" },
    ]);
    mockGetMirrorsIntoGroupForUser.mockResolvedValue([]);
  });

  it("lists every member with their candidate sources, flagging the mirrored ones", async () => {
    const { req, res } = makeReqRes({ params: { groupId: TARGET } });

    await handleGetGroupMirrors(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      groupId: TARGET,
      canManage: true,
      members: [
        expect.objectContaining({
          userId: MEMBER,
          candidates: [
            { groupId: SOURCE_B, groupName: "Leadership", mirrored: false, manageable: true },
            { groupId: SOURCE_A, groupName: "Team A", mirrored: true, manageable: true },
          ],
        }),
      ],
    });
  });

  it("never offers the group itself as a mirror source", async () => {
    const { req, res } = makeReqRes({ params: { groupId: TARGET } });

    await handleGetGroupMirrors(req, res);

    expect(mockGetAllGroups).toHaveBeenCalledWith([SOURCE_A, SOURCE_B]);
  });

  it("offers only sources the acting admin also administers", async () => {
    mockGetAdminGroupIdsForUser.mockResolvedValue([TARGET, SOURCE_A]);
    mockGetAllGroups.mockResolvedValue([{ id: SOURCE_A, groupName: "Team A" }]);
    const { req, res } = makeReqRes({ params: { groupId: TARGET } });

    await handleGetGroupMirrors(req, res);

    const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      members: { candidates: { groupId: string }[] }[];
    };
    expect(payload.members[0]?.candidates.map((c) => c.groupId)).toEqual([SOURCE_A]);
  });

  it("shows an active mirror from a group the admin does not administer, locked", async () => {
    mockGetAdminGroupIdsForUser.mockResolvedValue([TARGET, SOURCE_A]);
    mockGetAllGroups.mockResolvedValue([{ id: SOURCE_A, groupName: "Team A" }]);
    mockGetMembershipPairs.mockResolvedValue([{ userId: MEMBER, groupId: SOURCE_A }]);
    mockGetMirrorsIntoGroupForUsers.mockResolvedValue([
      { userId: MEMBER, sourceGroupId: UNMANAGED, sourceGroupName: "Hidden Team" },
    ]);
    const { req, res } = makeReqRes({ params: { groupId: TARGET } });

    await handleGetGroupMirrors(req, res);

    const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      members: { candidates: { groupId: string; mirrored: boolean; manageable: boolean }[] }[];
    };
    expect(payload.members[0]?.candidates).toContainEqual({
      groupId: UNMANAGED,
      groupName: "Hidden Team",
      mirrored: true,
      manageable: false,
    });
  });

  it("gives a non-admin their own mirrors read-only", async () => {
    mockGetGroupUser.mockResolvedValue({ viewAccess: true, adminAccess: false });
    mockGetMirrorsIntoGroupForUser.mockResolvedValue([
      { sourceGroupId: SOURCE_A, sourceGroupName: "Team A" },
    ]);
    const { req, res } = makeReqRes({ params: { groupId: TARGET } });

    await handleGetGroupMirrors(req, res);

    expect(res.json).toHaveBeenCalledWith({
      groupId: TARGET,
      canManage: false,
      members: [
        expect.objectContaining({
          userId: mockAuthData.userId,
          candidates: [
            { groupId: SOURCE_A, groupName: "Team A", mirrored: true, manageable: false },
          ],
        }),
      ],
    });
    expect(mockGetGroupUsers).not.toHaveBeenCalled();
  });

  it("403s for a caller who does not belong to the group", async () => {
    mockGetGroupUser.mockResolvedValue(undefined);
    const { req, res } = makeReqRes({ params: { groupId: TARGET } });

    await expect(handleGetGroupMirrors(req, res)).rejects.toMatchObject({ code: 403 });
  });
});

describe("handlePutGroupMirrors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthData);
    mockGetGroupUser.mockResolvedValue({ adminAccess: true });
    mockGetAdminGroupIdsForUser.mockResolvedValue([TARGET, SOURCE_A, SOURCE_B]);
    mockGetMembershipPairs.mockImplementation((_userIds: string[], groupIds: string[]) =>
      Promise.resolve(groupIds.map((groupId) => ({ userId: MEMBER, groupId })))
    );
    mockSetMirrorsIntoGroupForUser.mockResolvedValue([]);
  });

  const put = (sourceGroupIds: string[], userId = MEMBER) =>
    makeReqRes({ params: { groupId: TARGET }, body: { userId, sourceGroupIds } });

  it("replaces the member's mirror sources within the admin's reach", async () => {
    const { req, res } = put([SOURCE_A, SOURCE_B]);

    await handlePutGroupMirrors(req, res);

    expect(mockSetMirrorsIntoGroupForUser).toHaveBeenCalledWith(
      MEMBER,
      TARGET,
      [SOURCE_A, SOURCE_B],
      [SOURCE_A, SOURCE_B],
      expect.anything()
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("turns the admin's manageable mirrors off with an empty array", async () => {
    const { req, res } = put([]);

    await handlePutGroupMirrors(req, res);

    expect(mockSetMirrorsIntoGroupForUser).toHaveBeenCalledWith(
      MEMBER,
      TARGET,
      [],
      [SOURCE_A, SOURCE_B],
      expect.anything()
    );
  });

  it("refuses a caller who is only a plain member of the target group", async () => {
    mockGetGroupUser.mockResolvedValue({ adminAccess: false });
    const { req, res } = put([SOURCE_A]);

    await expect(handlePutGroupMirrors(req, res)).rejects.toMatchObject({ code: 403 });
    expect(mockSetMirrorsIntoGroupForUser).not.toHaveBeenCalled();
  });

  it("refuses a caller who does not belong to the target group", async () => {
    mockGetGroupUser.mockResolvedValue(undefined);
    const { req, res } = put([SOURCE_A]);

    await expect(handlePutGroupMirrors(req, res)).rejects.toMatchObject({ code: 403 });
    expect(mockSetMirrorsIntoGroupForUser).not.toHaveBeenCalled();
  });

  it("refuses a source group the caller does not administer", async () => {
    const { req, res } = put([SOURCE_A, OUTSIDER]);

    await expect(handlePutGroupMirrors(req, res)).rejects.toMatchObject({ code: 403 });
    expect(mockSetMirrorsIntoGroupForUser).not.toHaveBeenCalled();
  });

  it("refuses a member who does not belong to the target group", async () => {
    mockGetGroupUser.mockImplementation((userId: string) =>
      Promise.resolve(userId === mockAuthData.userId ? { adminAccess: true } : undefined)
    );
    const { req, res } = put([SOURCE_A]);

    await expect(handlePutGroupMirrors(req, res)).rejects.toMatchObject({ code: 422 });
    expect(mockSetMirrorsIntoGroupForUser).not.toHaveBeenCalled();
  });

  it("refuses a source group the member does not belong to", async () => {
    mockGetMembershipPairs.mockResolvedValue([{ userId: MEMBER, groupId: SOURCE_A }]);
    const { req, res } = put([SOURCE_A, SOURCE_B]);

    await expect(handlePutGroupMirrors(req, res)).rejects.toMatchObject({ code: 422 });
    expect(mockSetMirrorsIntoGroupForUser).not.toHaveBeenCalled();
  });

  it("refuses to mirror a group into itself", async () => {
    const { req, res } = put([TARGET]);

    await expect(handlePutGroupMirrors(req, res)).rejects.toMatchObject({ code: 422 });
    expect(mockSetMirrorsIntoGroupForUser).not.toHaveBeenCalled();
  });
});

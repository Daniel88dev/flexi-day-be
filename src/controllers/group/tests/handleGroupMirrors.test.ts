import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetGroupUser,
  mockGetAllGroupsForUser,
  mockGetAllGroups,
  mockGetMirrorsIntoGroupForUser,
  mockSetMirrorsIntoGroupForUser,
} = vi.hoisted(() => ({
  mockGetGroupUser: vi.fn(),
  mockGetAllGroupsForUser: vi.fn(),
  mockGetAllGroups: vi.fn(),
  mockGetMirrorsIntoGroupForUser: vi.fn(),
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
      getAllGroupsForUser: mockGetAllGroupsForUser,
    },
    group: { getAllGroups: mockGetAllGroups },
    groupMirror: {
      getMirrorsIntoGroupForUser: mockGetMirrorsIntoGroupForUser,
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
const OUTSIDER = "550e8400-e29b-41d4-a716-446655440009";

describe("handleGetGroupMirrors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthData);
    mockGetGroupUser.mockResolvedValue({ viewAccess: true });
    mockGetAllGroupsForUser.mockResolvedValue([
      { groupId: TARGET },
      { groupId: SOURCE_A },
      { groupId: SOURCE_B },
    ]);
    mockGetAllGroups.mockResolvedValue([
      { id: SOURCE_A, groupName: "Team A" },
      { id: SOURCE_B, groupName: "Leadership" },
    ]);
    mockGetMirrorsIntoGroupForUser.mockResolvedValue([{ sourceGroupId: SOURCE_A }]);
  });

  it("lists the caller's other groups, flagging the mirrored ones", async () => {
    const { req, res } = makeReqRes({ params: { groupId: TARGET } });

    await handleGetGroupMirrors(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      groupId: TARGET,
      candidates: [
        { groupId: SOURCE_A, groupName: "Team A", mirrored: true },
        { groupId: SOURCE_B, groupName: "Leadership", mirrored: false },
      ],
    });
  });

  it("never offers the group itself as a mirror source", async () => {
    const { req, res } = makeReqRes({ params: { groupId: TARGET } });

    await handleGetGroupMirrors(req, res);

    expect(mockGetAllGroups).toHaveBeenCalledWith([SOURCE_A, SOURCE_B]);
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
    mockGetAllGroupsForUser.mockResolvedValue([
      { groupId: TARGET },
      { groupId: SOURCE_A },
      { groupId: SOURCE_B },
    ]);
    mockSetMirrorsIntoGroupForUser.mockResolvedValue([]);
  });

  const put = (sourceGroupIds: string[]) =>
    makeReqRes({ params: { groupId: TARGET }, body: { sourceGroupIds } });

  it("replaces the caller's mirror sources", async () => {
    const { req, res } = put([SOURCE_A, SOURCE_B]);

    await handlePutGroupMirrors(req, res);

    expect(mockSetMirrorsIntoGroupForUser).toHaveBeenCalledWith(
      mockAuthData.userId,
      TARGET,
      [SOURCE_A, SOURCE_B],
      expect.anything()
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("turns mirroring off with an empty array", async () => {
    const { req, res } = put([]);

    await handlePutGroupMirrors(req, res);

    expect(mockSetMirrorsIntoGroupForUser).toHaveBeenCalledWith(
      mockAuthData.userId,
      TARGET,
      [],
      expect.anything()
    );
  });

  it("refuses a source group the caller does not belong to", async () => {
    const { req, res } = put([SOURCE_A, OUTSIDER]);

    await expect(handlePutGroupMirrors(req, res)).rejects.toMatchObject({ code: 403 });
    expect(mockSetMirrorsIntoGroupForUser).not.toHaveBeenCalled();
  });

  it("refuses when the caller does not belong to the target group", async () => {
    mockGetAllGroupsForUser.mockResolvedValue([{ groupId: SOURCE_A }]);
    const { req, res } = put([SOURCE_A]);

    await expect(handlePutGroupMirrors(req, res)).rejects.toMatchObject({ code: 403 });
    expect(mockSetMirrorsIntoGroupForUser).not.toHaveBeenCalled();
  });

  it("refuses to mirror a group into itself", async () => {
    const { req, res } = put([TARGET]);

    await expect(handlePutGroupMirrors(req, res)).rejects.toMatchObject({ code: 422 });
    expect(mockSetMirrorsIntoGroupForUser).not.toHaveBeenCalled();
  });
});

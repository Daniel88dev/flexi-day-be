import { describe, it, expect, vi, beforeEach } from "vitest";

// Billing plan-limit guards are no-ops here; their behavior has its own suite.
// `isOrganizationAdmin` returns false so these cases exercise membership alone
// — org-admin access has its own suite.
vi.mock("../../../services/organization/organizationServices.js", () => ({
  lockOrganization: vi.fn(),
  isOrganizationAdmin: vi.fn().mockResolvedValue(false),
  getAdminOrganizationsForUser: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../services/billing/guards.js", () => ({
  assertCanCreateGroup: vi.fn(),
  assertCanAddMember: vi.fn(),
  assertGroupWritable: vi.fn(),
  assertGroupsWritable: vi.fn(),
}));

const {
  mockGetGroupUser,
  mockGetGroup,
  mockGetUserByEmail,
  mockCreateInviteLink,
  mockRevokeOpenInviteForEmail,
  mockNotifyGroupInvited,
} = vi.hoisted(() => ({
  mockGetGroupUser: vi.fn(),
  mockGetGroup: vi.fn(),
  mockGetUserByEmail: vi.fn(),
  mockCreateInviteLink: vi.fn(),
  mockRevokeOpenInviteForEmail: vi.fn(),
  mockNotifyGroupInvited: vi.fn(),
}));

vi.mock("../../../middleware/authSession.js", () => ({ getAuth: vi.fn() }));

vi.mock("../../../db/db.js", () => ({
  db: { transaction: vi.fn((callback) => callback({})) },
}));

// `assertGroupAdmin` reaches for the service modules directly rather than
// through createDBServices, so both routes must resolve to the same mock.
vi.mock("../../../services/groupUser/groupUserServices.js", () => ({
  getGroupUser: mockGetGroupUser,
  getAdminGroupIdsForUser: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../services/group/groupServices.js", () => ({
  getGroup: mockGetGroup,
  getLiveGroupIdsForOrganizations: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../services/DBServices.js", () => ({
  createDBServices: () => ({
    groupUser: { getGroupUser: mockGetGroupUser },
    group: { getGroup: mockGetGroup },
    user: { getUserByEmail: mockGetUserByEmail },
    inviteLinks: {
      createInviteLink: mockCreateInviteLink,
      revokeOpenInviteForEmail: mockRevokeOpenInviteForEmail,
    },
  }),
}));

vi.mock("../../../services/groupUser/inviteNotifier.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../services/groupUser/inviteNotifier.js")
  >();
  return { ...actual, notifyGroupInvited: mockNotifyGroupInvited };
});

import { handlePostGroupInvite } from "../handlePostGroupInvite.js";
import { getAuth } from "../../../middleware/authSession.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";

const GROUP_ID = "550e8400-e29b-41d4-a716-446655440000";

const admin = { viewAccess: true, adminAccess: true, controlledUser: true };
const plainMember = { viewAccess: true, adminAccess: false, controlledUser: true };

describe("handlePostGroupInvite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthData);
    mockGetGroupUser.mockResolvedValue(admin);
    mockGetGroup.mockResolvedValue({ id: GROUP_ID, groupName: "Platform" });
    mockGetUserByEmail.mockResolvedValue(undefined);
    mockCreateInviteLink.mockImplementation((data: { code: string }) =>
      Promise.resolve({ id: "invite-1", ...data })
    );
    mockNotifyGroupInvited.mockResolvedValue(true);
  });

  const invite = (email = "sam@northwind.co") =>
    makeReqRes({ params: { groupId: GROUP_ID }, body: { email } });

  it("issues a code and emails it to the invited address", async () => {
    const { req, res } = invite();

    await handlePostGroupInvite(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const created = mockCreateInviteLink.mock.calls[0]?.[0] as {
      email: string;
      groupId: string;
      code: string;
      invitedByUserId: string;
    };
    expect(created.email).toBe("sam@northwind.co");
    expect(created.groupId).toBe(GROUP_ID);
    expect(created.invitedByUserId).toBe(mockAuthData.userId);
    expect(created.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    expect(mockNotifyGroupInvited).toHaveBeenCalledWith({
      email: "sam@northwind.co",
      groupName: "Platform",
      inviterName: mockAuthData.userName,
      code: created.code,
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ emailDelivered: true }));
  });

  it("stores the address lower-cased so redemption matches", async () => {
    const { req, res } = invite();
    // The route's zod schema lower-cases before the handler sees it.
    req.body = { email: "sam@northwind.co" };

    await handlePostGroupInvite(req, res);

    expect(mockCreateInviteLink.mock.calls[0]?.[0]).toMatchObject({
      email: "sam@northwind.co",
    });
  });

  it("revokes any earlier open invite for the same address first", async () => {
    const { req, res } = invite();

    await handlePostGroupInvite(req, res);

    expect(mockRevokeOpenInviteForEmail).toHaveBeenCalledWith(
      GROUP_ID,
      "sam@northwind.co",
      expect.anything()
    );
  });

  it("still returns the code when the email could not be sent", async () => {
    mockNotifyGroupInvited.mockResolvedValue(false);
    const { req, res } = invite();

    await handlePostGroupInvite(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ emailDelivered: false }));
  });

  it("sets an expiry in the future", async () => {
    const { req, res } = invite();

    await handlePostGroupInvite(req, res);

    const { expiresAt } = mockCreateInviteLink.mock.calls[0]?.[0] as { expiresAt: Date };
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects a caller without admin access", async () => {
    mockGetGroupUser.mockResolvedValue(plainMember);
    const { req, res } = invite();

    await expect(handlePostGroupInvite(req, res)).rejects.toMatchObject({ code: 403 });
    expect(mockCreateInviteLink).not.toHaveBeenCalled();
  });

  it("rejects a caller who is not in the group at all", async () => {
    mockGetGroupUser.mockResolvedValue(undefined);
    const { req, res } = invite();

    await expect(handlePostGroupInvite(req, res)).rejects.toMatchObject({ code: 403 });
  });

  it("404s when the group does not exist", async () => {
    mockGetGroup.mockResolvedValue(undefined);
    const { req, res } = invite();

    await expect(handlePostGroupInvite(req, res)).rejects.toMatchObject({ code: 404 });
  });

  it("409s when the invited person already belongs to the group", async () => {
    mockGetUserByEmail.mockResolvedValue({ id: "existing-user" });
    // First call is the caller's admin check, second is the invitee's membership.
    mockGetGroupUser.mockResolvedValueOnce(admin).mockResolvedValueOnce(plainMember);
    const { req, res } = invite();

    await expect(handlePostGroupInvite(req, res)).rejects.toMatchObject({ code: 409 });
    expect(mockCreateInviteLink).not.toHaveBeenCalled();
  });

  it("invites an existing account that is not in this group yet", async () => {
    mockGetUserByEmail.mockResolvedValue({ id: "existing-user" });
    mockGetGroupUser.mockResolvedValueOnce(admin).mockResolvedValueOnce(undefined);
    const { req, res } = invite();

    await handlePostGroupInvite(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
  });
});

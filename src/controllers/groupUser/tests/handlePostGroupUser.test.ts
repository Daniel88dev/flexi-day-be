import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetInviteLinkByCode, mockUseInviteLink, mockCreateGroupUser, mockGetGroupUser } =
  vi.hoisted(() => ({
    mockGetInviteLinkByCode: vi.fn(),
    mockUseInviteLink: vi.fn(),
    mockCreateGroupUser: vi.fn(),
    mockGetGroupUser: vi.fn(),
  }));

vi.mock("../../../middleware/authSession.js", () => ({ getAuth: vi.fn() }));

vi.mock("../../../db/db.js", () => ({
  db: { transaction: vi.fn((callback) => callback({})) },
}));

vi.mock("../../../services/DBServices.js", () => ({
  createDBServices: () => ({
    groupUser: { createGroupUser: mockCreateGroupUser, getGroupUser: mockGetGroupUser },
    inviteLinks: {
      getInviteLinkByCode: mockGetInviteLinkByCode,
      useInviteLink: mockUseInviteLink,
    },
  }),
}));

import { handlePostGroupUser } from "../handlePostGroupUser.js";
import { getAuth } from "../../../middleware/authSession.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";

const GROUP_ID = "550e8400-e29b-41d4-a716-446655440000";
const CODE = "ABCD-EFGH-JKMN";

const tomorrow = () => new Date(Date.now() + 24 * 60 * 60 * 1000);
const yesterday = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

const openInvite = (overrides: Record<string, unknown> = {}) => ({
  id: "invite-1",
  groupId: GROUP_ID,
  code: CODE,
  email: mockAuthData.userEmail,
  usedAt: null,
  revokedAt: null,
  expiresAt: tomorrow(),
  ...overrides,
});

describe("handlePostGroupUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthData);
    mockGetInviteLinkByCode.mockResolvedValue(openInvite());
    mockGetGroupUser.mockResolvedValue(undefined);
    mockCreateGroupUser.mockResolvedValue({ id: "membership-1", groupId: GROUP_ID });
    mockUseInviteLink.mockResolvedValue(openInvite({ usedAt: new Date() }));
  });

  const redeem = (code = CODE) => makeReqRes({ params: { validationCode: code } });

  it("joins the group and burns the code", async () => {
    const { req, res } = redeem();

    await handlePostGroupUser(req, res);

    expect(mockCreateGroupUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: mockAuthData.userId,
        groupId: GROUP_ID,
        viewAccess: true,
        adminAccess: false,
        controlledUser: true,
      }),
      expect.anything()
    );
    expect(mockUseInviteLink).toHaveBeenCalledWith(CODE, expect.anything());
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("accepts the code lower-cased and without dashes", async () => {
    const { req, res } = redeem("abcdefghjkmn");

    await handlePostGroupUser(req, res);

    // Normalised to the stored form before the lookup.
    expect(mockGetInviteLinkByCode).toHaveBeenCalledWith(CODE, expect.anything());
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("refuses an invite issued to a different address", async () => {
    mockGetInviteLinkByCode.mockResolvedValue(openInvite({ email: "someone.else@northwind.co" }));
    const { req, res } = redeem();

    await expect(handlePostGroupUser(req, res)).rejects.toMatchObject({ code: 403 });
    expect(mockCreateGroupUser).not.toHaveBeenCalled();
    expect(mockUseInviteLink).not.toHaveBeenCalled();
  });

  it("matches the invited address case-insensitively", async () => {
    mockGetInviteLinkByCode.mockResolvedValue(
      openInvite({ email: mockAuthData.userEmail.toLowerCase() })
    );
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue({
      ...mockAuthData,
      userEmail: mockAuthData.userEmail.toUpperCase(),
    });
    const { req, res } = redeem();

    await handlePostGroupUser(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("lets anyone redeem a legacy invite that carries no address", async () => {
    mockGetInviteLinkByCode.mockResolvedValue(openInvite({ email: null }));
    const { req, res } = redeem();

    await handlePostGroupUser(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("rejects a revoked invite", async () => {
    mockGetInviteLinkByCode.mockResolvedValue(openInvite({ revokedAt: new Date() }));
    const { req, res } = redeem();

    await expect(handlePostGroupUser(req, res)).rejects.toMatchObject({ code: 404 });
    expect(mockCreateGroupUser).not.toHaveBeenCalled();
  });

  it("rejects an already used invite", async () => {
    mockGetInviteLinkByCode.mockResolvedValue(openInvite({ usedAt: new Date() }));
    const { req, res } = redeem();

    await expect(handlePostGroupUser(req, res)).rejects.toMatchObject({ code: 404 });
  });

  it("rejects an expired invite", async () => {
    mockGetInviteLinkByCode.mockResolvedValue(openInvite({ expiresAt: yesterday() }));
    const { req, res } = redeem();

    await expect(handlePostGroupUser(req, res)).rejects.toMatchObject({ code: 404 });
  });

  it("rejects an unknown code", async () => {
    mockGetInviteLinkByCode.mockResolvedValue(undefined);
    const { req, res } = redeem();

    await expect(handlePostGroupUser(req, res)).rejects.toMatchObject({ code: 404 });
  });

  it("rejects a malformed code without touching the database", async () => {
    const { req, res } = redeem("not-a-code");

    await expect(handlePostGroupUser(req, res)).rejects.toMatchObject({ code: 400 });
    expect(mockGetInviteLinkByCode).not.toHaveBeenCalled();
  });

  it("409s when the caller already belongs to the group", async () => {
    mockGetGroupUser.mockResolvedValue({ id: "existing" });
    const { req, res } = redeem();

    await expect(handlePostGroupUser(req, res)).rejects.toMatchObject({ code: 409 });
    expect(mockCreateGroupUser).not.toHaveBeenCalled();
  });

  it("409s when a concurrent redemption burned the code first", async () => {
    // The `usedAt IS NULL` predicate in useInviteLink matched no row.
    mockUseInviteLink.mockResolvedValue(undefined);
    const { req, res } = redeem();

    await expect(handlePostGroupUser(req, res)).rejects.toMatchObject({ code: 409 });
  });
});

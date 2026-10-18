import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockSignUpEmail,
  mockCreateGroup,
  mockCreateGroupUser,
  mockDelete,
  mockOpenQuotaFromGroupDefaults,
  mockEnsureOrganizationForUser,
  mockGetUserByEmail,
  mockGetUserById,
  mockDeleteUserByIdAndEmail,
} = vi.hoisted(() => ({
  mockSignUpEmail: vi.fn(),
  mockCreateGroup: vi.fn(),
  mockCreateGroupUser: vi.fn(),
  mockDelete: vi.fn(),
  mockOpenQuotaFromGroupDefaults: vi.fn(),
  mockEnsureOrganizationForUser: vi.fn(),
  mockGetUserByEmail: vi.fn(),
  mockGetUserById: vi.fn(),
  mockDeleteUserByIdAndEmail: vi.fn(),
}));

vi.mock("../../../utils/auth.js", () => ({
  auth: { api: { signUpEmail: mockSignUpEmail } },
}));

vi.mock("better-auth/node", () => ({ fromNodeHeaders: () => ({}) }));

vi.mock("../../../db/db.js", () => ({
  db: {
    transaction: vi.fn((callback) => callback({})),
    delete: mockDelete,
  },
}));

vi.mock("../../../services/group/groupServices.js", () => ({
  createGroup: mockCreateGroup,
}));

vi.mock("../../../services/groupUser/groupUserServices.js", () => ({
  createGroupUser: mockCreateGroupUser,
}));

vi.mock("../../../services/organization/organizationServices.js", () => ({
  ensureOrganizationForUser: mockEnsureOrganizationForUser,
}));

vi.mock("../../../services/user/userServices.js", () => ({
  getUserByEmail: mockGetUserByEmail,
  getUserById: mockGetUserById,
  deleteUserByIdAndEmail: mockDeleteUserByIdAndEmail,
}));

vi.mock("../../../services/userYearQuotas/userYearQuotasServices.js", () => ({
  openQuotaFromGroupDefaults: mockOpenQuotaFromGroupDefaults,
}));

// Billing plan-limit guards are no-ops here; their behavior has its own suite.
vi.mock("../../../services/billing/guards.js", () => ({
  assertCanCreateGroup: vi.fn(),
  assertCanAddMember: vi.fn(),
  assertGroupWritable: vi.fn(),
  assertGroupsWritable: vi.fn(),
}));

import { handleSignUpWithTeam, validateSignUpWithTeam } from "../handleSignUpWithTeam.js";
import { makeReqRes } from "../../../tests/testUtils.js";

const NEW_USER = { id: "user-1", name: "Dana Holt", email: "dana@northwind.co" };

const okSignUp = (payload: object = { user: NEW_USER, token: "tok" }) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: () => Promise.resolve(payload),
});

const body = (extra: Record<string, unknown> = {}) => ({
  name: "Dana Holt",
  email: "dana@northwind.co",
  password: "supersecret",
  ...extra,
});

const makeReq = (raw: Record<string, unknown>) => {
  const parsed = validateSignUpWithTeam.parse(raw);
  const { req, res } = makeReqRes({ body: parsed });
  (req as unknown as { headers: object }).headers = {};
  return { req, res };
};

describe("validateSignUpWithTeam", () => {
  it("accepts a payload with no teamName", () => {
    expect(validateSignUpWithTeam.parse(body()).teamName).toBeUndefined();
  });

  it("treats a blank teamName as absent", () => {
    expect(validateSignUpWithTeam.parse(body({ teamName: "   " })).teamName).toBeUndefined();
  });

  it("keeps a real teamName", () => {
    expect(validateSignUpWithTeam.parse(body({ teamName: "Platform" })).teamName).toBe("Platform");
  });

  it("accepts a password up to better-auth's 128-character limit and rejects a longer one", () => {
    expect(validateSignUpWithTeam.safeParse(body({ password: "p".repeat(128) })).success).toBe(
      true
    );
    expect(validateSignUpWithTeam.safeParse(body({ password: "p".repeat(129) })).success).toBe(
      false
    );
  });
});

describe("handleSignUpWithTeam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignUpEmail.mockResolvedValue(okSignUp());
    mockCreateGroup.mockResolvedValue({ id: "group-1", groupName: "Platform" });
    mockCreateGroupUser.mockResolvedValue({ id: "membership-1" });
    mockEnsureOrganizationForUser.mockResolvedValue({ id: "org-1" });
    mockDelete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    mockGetUserByEmail.mockResolvedValue(undefined);
    mockGetUserById.mockResolvedValue(NEW_USER);
    mockDeleteUserByIdAndEmail.mockResolvedValue(true);
  });

  it("creates an account with no group when teamName is omitted", async () => {
    const { req, res } = makeReq(body());

    await handleSignUpWithTeam(req, res);

    expect(mockCreateGroup).not.toHaveBeenCalled();
    expect(mockCreateGroupUser).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ group: null }));
  });

  it("still creates the group when a teamName is supplied", async () => {
    const { req, res } = makeReq(body({ teamName: "Platform" }));

    await handleSignUpWithTeam(req, res);

    expect(mockCreateGroup).toHaveBeenCalledWith(
      expect.objectContaining({ groupName: "Platform", managerUserId: NEW_USER.id }),
      expect.anything()
    );
    expect(mockCreateGroupUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: NEW_USER.id, adminAccess: true, controlledUser: true }),
      expect.anything()
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ group: { id: "group-1", groupName: "Platform" } })
    );
  });

  it("rolls the auth user back when group creation fails", async () => {
    mockCreateGroup.mockResolvedValue(undefined);
    const { req, res } = makeReq(body({ teamName: "Platform" }));

    await expect(handleSignUpWithTeam(req, res)).rejects.toMatchObject({ code: 500 });
    expect(mockDeleteUserByIdAndEmail).toHaveBeenCalledExactlyOnceWith(NEW_USER.id, NEW_USER.email);
    expect(mockDelete).toHaveBeenCalledOnce();
    // The session cookie must never reach a caller we just rolled back.
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rolls the new user back when checking it fails after better-auth created it", async () => {
    const lookupFailure = new Error("connection reset");
    mockGetUserById.mockRejectedValue(lookupFailure);
    const { req, res } = makeReq(body({ teamName: "Platform" }));

    await expect(handleSignUpWithTeam(req, res)).rejects.toBe(lookupFailure);
    expect(mockDeleteUserByIdAndEmail).toHaveBeenCalledExactlyOnceWith(NEW_USER.id, NEW_USER.email);
    expect(mockCreateGroup).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("leaves verification rows alone when the rollback removes no user", async () => {
    mockCreateGroup.mockResolvedValue(undefined);
    mockDeleteUserByIdAndEmail.mockResolvedValue(false);
    const { req, res } = makeReq(body({ teamName: "Platform" }));

    await expect(handleSignUpWithTeam(req, res)).rejects.toMatchObject({ code: 500 });
    expect(mockDeleteUserByIdAndEmail).toHaveBeenCalledOnce();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it.each([
    ["the address already had an account", () => mockGetUserByEmail.mockResolvedValue(NEW_USER)],
    ["the returned user was never saved", () => mockGetUserById.mockResolvedValue(undefined)],
    [
      "the returned id belongs to another address",
      () => mockGetUserById.mockResolvedValue({ ...NEW_USER, email: "someone@else.co" }),
    ],
  ])("creates no team and deletes nothing when %s", async (_case, arrange) => {
    arrange();
    mockSignUpEmail.mockResolvedValue(okSignUp({ user: NEW_USER, token: null }));
    const { req, res } = makeReq(body({ teamName: "Platform" }));

    await handleSignUpWithTeam(req, res);

    expect(mockEnsureOrganizationForUser).not.toHaveBeenCalled();
    expect(mockCreateGroup).not.toHaveBeenCalled();
    expect(mockDeleteUserByIdAndEmail).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ user: NEW_USER, token: null, group: null });
  });

  it("deletes nothing when better-auth succeeds without a user id", async () => {
    mockSignUpEmail.mockResolvedValue(okSignUp({}));
    const { req, res } = makeReq(body({ teamName: "Platform" }));

    await expect(handleSignUpWithTeam(req, res)).rejects.toMatchObject({ code: 500 });
    expect(mockDeleteUserByIdAndEmail).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("surfaces a better-auth failure without creating anything locally", async () => {
    mockSignUpEmail.mockResolvedValue({
      ok: false,
      status: 422,
      headers: new Headers(),
      json: () => Promise.resolve({ message: "Email already taken" }),
    });
    const { req, res } = makeReq(body());

    await expect(handleSignUpWithTeam(req, res)).rejects.toMatchObject({ code: 422 });
    expect(mockCreateGroup).not.toHaveBeenCalled();
  });
});

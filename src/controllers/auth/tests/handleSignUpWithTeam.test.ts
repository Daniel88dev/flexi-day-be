import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockSignUpEmail,
  mockCreateGroup,
  mockCreateGroupUser,
  mockDelete,
  mockOpenQuotaFromGroupDefaults,
  mockEnsureOrganizationForUser,
} = vi.hoisted(() => ({
  mockSignUpEmail: vi.fn(),
  mockCreateGroup: vi.fn(),
  mockCreateGroupUser: vi.fn(),
  mockDelete: vi.fn(),
  mockOpenQuotaFromGroupDefaults: vi.fn(),
  mockEnsureOrganizationForUser: vi.fn(),
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

vi.mock("../../../services/DBServices.js", () => ({
  createDBServices: () => ({
    group: { createGroup: mockCreateGroup },
    groupUser: { createGroupUser: mockCreateGroupUser },
    userYearQuotas: { openQuotaFromGroupDefaults: mockOpenQuotaFromGroupDefaults },
    organization: { ensureOrganizationForUser: mockEnsureOrganizationForUser },
  }),
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

const okSignUp = () => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: () => Promise.resolve({ user: NEW_USER, token: "tok" }),
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
});

describe("handleSignUpWithTeam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignUpEmail.mockResolvedValue(okSignUp());
    mockCreateGroup.mockResolvedValue({ id: "group-1", groupName: "Platform" });
    mockCreateGroupUser.mockResolvedValue({ id: "membership-1" });
    mockEnsureOrganizationForUser.mockResolvedValue({ id: "org-1" });
    mockDelete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
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
    expect(mockDelete).toHaveBeenCalled();
    // The session cookie must never reach a caller we just rolled back.
    expect(res.status).not.toHaveBeenCalled();
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

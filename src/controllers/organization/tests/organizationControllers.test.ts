import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetOrganizationById,
  mockGetAdminOrganizationsForUser,
  mockIsOrganizationAdmin,
  mockUpdateOrganization,
  mockListOrganizationAdmins,
  mockListOrganizationAdminCandidates,
  mockGrantOrganizationAdmin,
  mockRemoveOrganizationAdmin,
  mockGetSubscriptionForOrganization,
  mockGetGroupUsageForOrganization,
} = vi.hoisted(() => ({
  mockGetOrganizationById: vi.fn(),
  mockGetAdminOrganizationsForUser: vi.fn(),
  mockIsOrganizationAdmin: vi.fn(),
  mockUpdateOrganization: vi.fn(),
  mockListOrganizationAdmins: vi.fn(),
  mockListOrganizationAdminCandidates: vi.fn(),
  mockGrantOrganizationAdmin: vi.fn(),
  mockRemoveOrganizationAdmin: vi.fn(),
  mockGetSubscriptionForOrganization: vi.fn(),
  mockGetGroupUsageForOrganization: vi.fn(),
}));

vi.mock("../../../middleware/authSession.js", () => ({ getAuth: vi.fn() }));

vi.mock("../../../services/billing/subscriptionServices.js", () => ({
  getSubscriptionForOrganization: mockGetSubscriptionForOrganization,
}));

vi.mock("../../../services/group/groupServices.js", () => ({
  getGroupUsageForOrganization: mockGetGroupUsageForOrganization,
}));

vi.mock("../../../services/groupUser/groupUserServices.js", () => ({
  countActiveMembershipsInOrganization: vi.fn().mockResolvedValue(1),
}));

vi.mock("../../../services/organization/organizationServices.js", () => ({
  getOrganizationById: mockGetOrganizationById,
  getAdminOrganizationsForUser: mockGetAdminOrganizationsForUser,
  isOrganizationAdmin: mockIsOrganizationAdmin,
  updateOrganization: mockUpdateOrganization,
  listOrganizationAdmins: mockListOrganizationAdmins,
  listOrganizationAdminCandidates: mockListOrganizationAdminCandidates,
  grantOrganizationAdmin: mockGrantOrganizationAdmin,
  removeOrganizationAdmin: mockRemoveOrganizationAdmin,
}));

import { handleGetOrganization } from "../handleGetOrganization.js";
import { handlePatchOrganization } from "../handlePatchOrganization.js";
import { handleGetOrganizationCandidates } from "../handleGetOrganizationCandidates.js";
import { handlePostOrganizationAdmin } from "../handlePostOrganizationAdmin.js";
import { handleDeleteOrganizationAdmin } from "../handleDeleteOrganizationAdmin.js";
import { getAuth } from "../../../middleware/authSession.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";

const OWNER = mockAuthData.userId;
const DELEGATE = "delegate_789";

const organization = {
  id: "org-1",
  name: "Acme",
  ownerUserId: OWNER,
  billingEmail: "billing@acme.test",
  paddleCustomerId: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

/** The same organization seen by a delegated admin rather than its owner. */
const foreignOrganization = { ...organization, ownerUserId: "someone_else" };

describe("organization controllers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuth).mockReturnValue(mockAuthData);
    mockIsOrganizationAdmin.mockResolvedValue(true);
    mockGetAdminOrganizationsForUser.mockResolvedValue([organization]);
    mockGetSubscriptionForOrganization.mockResolvedValue(undefined);
    mockGetGroupUsageForOrganization.mockResolvedValue([]);
    mockListOrganizationAdmins.mockResolvedValue([]);
  });

  describe("handleGetOrganization", () => {
    it("returns the caller's own organization when none is named", async () => {
      const { req, res } = makeReqRes();

      await handleGetOrganization(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(vi.mocked(res.json).mock.calls[0]?.[0]).toMatchObject({
        organization: { id: "org-1", isOwner: true, billingEmail: "billing@acme.test" },
        plan: { plan: "FREE", status: null },
      });
    });

    it("hides the billing address from a delegated admin", async () => {
      mockGetAdminOrganizationsForUser.mockResolvedValue([foreignOrganization]);
      const { req, res } = makeReqRes();

      await handleGetOrganization(req, res);

      expect(vi.mocked(res.json).mock.calls[0]?.[0]).toMatchObject({
        organization: { isOwner: false, billingEmail: null },
      });
    });

    it("403s for an organization the caller does not administer", async () => {
      mockGetOrganizationById.mockResolvedValue(foreignOrganization);
      mockIsOrganizationAdmin.mockResolvedValue(false);
      const { req, res } = makeReqRes({ query: { organizationId: "org-1" } });

      await expect(handleGetOrganization(req, res)).rejects.toThrow(
        "No permission for related organization"
      );
    });

    it("404s for a caller with no organization yet", async () => {
      mockGetAdminOrganizationsForUser.mockResolvedValue([]);
      const { req, res } = makeReqRes();

      await expect(handleGetOrganization(req, res)).rejects.toThrow("Organization not found");
    });
  });

  describe("handlePatchOrganization", () => {
    it("lets any organization admin rename it", async () => {
      mockGetAdminOrganizationsForUser.mockResolvedValue([foreignOrganization]);
      mockUpdateOrganization.mockResolvedValue({ ...foreignOrganization, name: "Renamed" });
      const { req, res } = makeReqRes({ body: { name: "Renamed" } });

      await handlePatchOrganization(req, res);

      expect(mockUpdateOrganization).toHaveBeenCalledWith("org-1", { name: "Renamed" });
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it("refuses a billing address change from a delegated admin", async () => {
      mockGetAdminOrganizationsForUser.mockResolvedValue([foreignOrganization]);
      const { req, res } = makeReqRes({ body: { billingEmail: "new@acme.test" } });

      await expect(handlePatchOrganization(req, res)).rejects.toThrow(
        "Only the organization owner can perform this action"
      );
      expect(mockUpdateOrganization).not.toHaveBeenCalled();
    });

    it("lets the owner change the billing address", async () => {
      mockUpdateOrganization.mockResolvedValue({ ...organization, billingEmail: "new@acme.test" });
      const { req, res } = makeReqRes({ body: { billingEmail: "new@acme.test" } });

      await handlePatchOrganization(req, res);

      expect(mockUpdateOrganization).toHaveBeenCalledWith("org-1", {
        billingEmail: "new@acme.test",
      });
    });
  });

  describe("handleGetOrganizationCandidates", () => {
    it("is owner-only", async () => {
      mockGetAdminOrganizationsForUser.mockResolvedValue([foreignOrganization]);
      const { req, res } = makeReqRes();

      await expect(handleGetOrganizationCandidates(req, res)).rejects.toThrow(
        "Only the organization owner can perform this action"
      );
    });

    it("returns the candidate list for the owner", async () => {
      mockListOrganizationAdminCandidates.mockResolvedValue([{ userId: DELEGATE }]);
      const { req, res } = makeReqRes();

      await handleGetOrganizationCandidates(req, res);

      expect(res.json).toHaveBeenCalledWith([{ userId: DELEGATE }]);
    });
  });

  describe("handlePostOrganizationAdmin", () => {
    it("refuses a grant from a delegated admin", async () => {
      mockGetAdminOrganizationsForUser.mockResolvedValue([foreignOrganization]);
      const { req, res } = makeReqRes({ body: { userId: DELEGATE } });

      await expect(handlePostOrganizationAdmin(req, res)).rejects.toThrow(
        "Only the organization owner can perform this action"
      );
      expect(mockGrantOrganizationAdmin).not.toHaveBeenCalled();
    });

    it("refuses someone who belongs to no group in the organization", async () => {
      mockListOrganizationAdminCandidates.mockResolvedValue([]);
      const { req, res } = makeReqRes({ body: { userId: DELEGATE } });

      await expect(handlePostOrganizationAdmin(req, res)).rejects.toThrow(
        "This user is not a member of any group in this organization"
      );
      expect(mockGrantOrganizationAdmin).not.toHaveBeenCalled();
    });

    it("grants to a candidate and returns the new admin list", async () => {
      mockListOrganizationAdminCandidates.mockResolvedValue([{ userId: DELEGATE }]);
      mockListOrganizationAdmins.mockResolvedValue([{ userId: OWNER }, { userId: DELEGATE }]);
      const { req, res } = makeReqRes({ body: { userId: DELEGATE } });

      await handlePostOrganizationAdmin(req, res);

      // The service re-checks eligibility under the organization lock; the
      // controller must hand it a way to do that.
      const grant = mockGrantOrganizationAdmin.mock.calls[0]?.[0] as {
        assertStillEligible?: unknown;
      };
      expect(typeof grant.assertStillEligible).toBe("function");

      expect(mockGrantOrganizationAdmin).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "org-1",
          userId: DELEGATE,
          grantedByUserId: OWNER,
        })
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });
  });

  describe("handleDeleteOrganizationAdmin", () => {
    it("refuses a revoke from a delegated admin", async () => {
      mockGetAdminOrganizationsForUser.mockResolvedValue([foreignOrganization]);
      const { req, res } = makeReqRes({ params: { userId: DELEGATE } });

      await expect(handleDeleteOrganizationAdmin(req, res)).rejects.toThrow(
        "Only the organization owner can perform this action"
      );
      expect(mockRemoveOrganizationAdmin).not.toHaveBeenCalled();
    });

    it("404s when the target was not an admin", async () => {
      mockRemoveOrganizationAdmin.mockResolvedValue(false);
      const { req, res } = makeReqRes({ params: { userId: DELEGATE } });

      await expect(handleDeleteOrganizationAdmin(req, res)).rejects.toThrow(
        "This user is not an administrator of this organization"
      );
    });

    it("revokes and returns the remaining admins", async () => {
      mockRemoveOrganizationAdmin.mockResolvedValue(true);
      mockListOrganizationAdmins.mockResolvedValue([{ userId: OWNER }]);
      const { req, res } = makeReqRes({ params: { userId: DELEGATE } });

      await handleDeleteOrganizationAdmin(req, res);

      expect(mockRemoveOrganizationAdmin).toHaveBeenCalledWith("org-1", DELEGATE);
      expect(res.json).toHaveBeenCalledWith([{ userId: OWNER }]);
    });
  });
});

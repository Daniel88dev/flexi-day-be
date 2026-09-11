import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockIsOrganizationAdmin,
  mockGetAdministrableGroupIds,
  mockGetActiveGroupIdsInOrganization,
  mockGetActiveMemberIdsForGroups,
} = vi.hoisted(() => ({
  mockIsOrganizationAdmin: vi.fn(),
  mockGetAdministrableGroupIds: vi.fn(),
  mockGetActiveGroupIdsInOrganization: vi.fn(),
  mockGetActiveMemberIdsForGroups: vi.fn(),
}));

vi.mock("../../organization/organizationServices.js", () => ({
  isOrganizationAdmin: mockIsOrganizationAdmin,
}));

vi.mock("../../groupUser/groupAccess.js", () => ({
  getAdministrableGroupIds: mockGetAdministrableGroupIds,
}));

vi.mock("../../groupUser/groupUserServices.js", () => ({
  getActiveGroupIdsInOrganization: mockGetActiveGroupIdsInOrganization,
  getActiveMemberIdsForGroups: mockGetActiveMemberIdsForGroups,
}));

import {
  assertEmploymentReadable,
  canReadEmployment,
  resolveRosterAudience,
} from "../attendanceAccess.js";

const ORGANIZATION = "org-1";
const employmentOf = (userId: string) => ({ organizationId: ORGANIZATION, userId });

describe("who may read an Employment", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockIsOrganizationAdmin.mockResolvedValue(false);
    mockGetAdministrableGroupIds.mockResolvedValue([]);
    mockGetActiveGroupIdsInOrganization.mockResolvedValue([]);
    mockGetActiveMemberIdsForGroups.mockResolvedValue([]);
  });

  it("lets a person read their own, without asking the database anything else", async () => {
    expect(await canReadEmployment("dana", employmentOf("dana"))).toBe(true);
    expect(mockIsOrganizationAdmin).not.toHaveBeenCalled();
  });

  it("lets an org admin read anyone's in that organization", async () => {
    mockIsOrganizationAdmin.mockResolvedValue(true);

    expect(await canReadEmployment("olivia", employmentOf("dana"))).toBe(true);
    expect(mockGetAdministrableGroupIds).not.toHaveBeenCalled();
  });

  it("lets a group admin read the Employment of someone in that group", async () => {
    mockGetActiveGroupIdsInOrganization.mockResolvedValue(["engineering"]);
    mockGetAdministrableGroupIds.mockResolvedValue(["engineering", "support"]);

    expect(await canReadEmployment("mark", employmentOf("dana"))).toBe(true);
  });

  it("refuses a group admin the Employment of someone in a group they do not administer", async () => {
    mockGetActiveGroupIdsInOrganization.mockResolvedValue(["support"]);
    mockGetAdministrableGroupIds.mockResolvedValue(["engineering"]);

    expect(await canReadEmployment("mark", employmentOf("dana"))).toBe(false);
  });

  // The manager holds no `group_users` row, so no group admin's scope contains
  // them — `docs/attendance.md` makes that the rule, not an accident.
  it("refuses a group admin someone who belongs to no group at all", async () => {
    mockGetActiveGroupIdsInOrganization.mockResolvedValue([]);
    mockGetAdministrableGroupIds.mockResolvedValue(["engineering"]);

    expect(await canReadEmployment("mark", employmentOf("other-manager"))).toBe(false);
  });

  it("refuses an ordinary colleague", async () => {
    expect(await canReadEmployment("otto", employmentOf("dana"))).toBe(false);
  });

  it("throws 403 from the assertion rather than returning false", async () => {
    await expect(assertEmploymentReadable("otto", employmentOf("dana"))).rejects.toMatchObject({
      code: 403,
    });
    await expect(assertEmploymentReadable("dana", employmentOf("dana"))).resolves.toBeUndefined();
  });
});

describe("the roster a viewer may list", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockIsOrganizationAdmin.mockResolvedValue(false);
    mockGetAdministrableGroupIds.mockResolvedValue([]);
    mockGetActiveMemberIdsForGroups.mockResolvedValue([]);
  });

  it("gives an org admin the whole organization", async () => {
    mockIsOrganizationAdmin.mockResolvedValue(true);

    expect(await resolveRosterAudience("olivia", ORGANIZATION)).toEqual({ everyone: true });
  });

  it("gives a group admin their groups' members", async () => {
    mockGetAdministrableGroupIds.mockResolvedValue(["engineering"]);
    mockGetActiveMemberIdsForGroups.mockResolvedValue(["dana", "dex"]);

    const audience = await resolveRosterAudience("mark", ORGANIZATION);

    expect(audience.everyone).toBe(false);
    expect(audience.everyone === false && audience.userIds.sort()).toEqual(["dana", "dex"]);
  });

  // A manager belongs to no group, so the roster they administer does not
  // contain them. `GET /api/employment` is where they read their own.
  it("does not add the viewer to a roster their membership does not put them in", async () => {
    mockGetAdministrableGroupIds.mockResolvedValue(["engineering"]);
    mockGetActiveMemberIdsForGroups.mockResolvedValue(["dana"]);

    const audience = await resolveRosterAudience("mark", ORGANIZATION);

    expect(audience.everyone === false && audience.userIds).toEqual(["dana"]);
  });

  it("refuses someone who administers nothing — the roster is an admin surface", async () => {
    await expect(resolveRosterAudience("dana", ORGANIZATION)).rejects.toMatchObject({ code: 403 });
  });
});

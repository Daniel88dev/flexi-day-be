import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetUserSettings, mockUpsertUserSettings, mockGetScopeEntries } = vi.hoisted(() => ({
  mockGetUserSettings: vi.fn(),
  mockUpsertUserSettings: vi.fn(),
  mockGetScopeEntries: vi.fn(),
}));

vi.mock("../../../middleware/authSession.js", () => ({
  getAuth: vi.fn(),
}));

vi.mock("../../../services/report/reportServices.js", () => ({
  getScopeEntries: mockGetScopeEntries,
}));

vi.mock("../../../services/userSettings/userSettingsServices.js", () => ({
  getUserSettings: mockGetUserSettings,
  upsertUserSettings: mockUpsertUserSettings,
}));

import { handleGetMySettings } from "../handleGetMySettings.js";
import { handlePutMySettings } from "../handlePutMySettings.js";
import { getAuth } from "../../../middleware/authSession.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";
import { dashboardScope } from "../../../db/schema/user-settings-schema.js";

const DEFAULTS = {
  emailNotifications: true,
  dashboardScope: dashboardScope.Mine,
  dashboardGroupId: null,
};

const scopeEntry = (access: "all" | "self") => ({
  groupId: "group_1",
  groupName: "Team A",
  access,
  canEditQuotas: false,
});

describe("user settings endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthData);
    mockGetUserSettings.mockResolvedValue(undefined);
  });

  it("defaults email notifications to on when the user has no stored settings", async () => {
    const { req, res } = makeReqRes();

    await handleGetMySettings(req, res);

    expect(res.json).toHaveBeenCalledWith(DEFAULTS);
  });

  it("returns the stored preference", async () => {
    const { req, res } = makeReqRes();
    mockGetUserSettings.mockResolvedValue({
      emailNotifications: false,
      dashboardScope: dashboardScope.Group,
      dashboardGroupId: "group_1",
    });

    await handleGetMySettings(req, res);

    expect(res.json).toHaveBeenCalledWith({
      emailNotifications: false,
      dashboardScope: dashboardScope.Group,
      dashboardGroupId: "group_1",
    });
  });

  it("saves the preference for the authenticated user", async () => {
    const { req, res } = makeReqRes({ body: { emailNotifications: false } });
    mockUpsertUserSettings.mockResolvedValue({ ...DEFAULTS, emailNotifications: false });

    await handlePutMySettings(req, res);

    expect(mockUpsertUserSettings).toHaveBeenCalledWith(mockAuthData.userId, {
      emailNotifications: false,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ...DEFAULTS, emailNotifications: false });
  });

  it("only sends the supplied fields to the store, leaving the rest untouched", async () => {
    const { req, res } = makeReqRes({
      body: { dashboardScope: dashboardScope.Group, dashboardGroupId: "group_1" },
    });
    mockGetScopeEntries.mockResolvedValue([scopeEntry("all")]);
    mockUpsertUserSettings.mockResolvedValue({
      ...DEFAULTS,
      dashboardScope: dashboardScope.Group,
      dashboardGroupId: "group_1",
    });

    await handlePutMySettings(req, res);

    expect(mockUpsertUserSettings).toHaveBeenCalledWith(mockAuthData.userId, {
      dashboardScope: dashboardScope.Group,
      dashboardGroupId: "group_1",
    });
  });

  it("accepts group scope when the group was already stored", async () => {
    const { req, res } = makeReqRes({ body: { dashboardScope: dashboardScope.Group } });
    mockGetUserSettings.mockResolvedValue({ ...DEFAULTS, dashboardGroupId: "group_1" });
    mockGetScopeEntries.mockResolvedValue([scopeEntry("all")]);
    mockUpsertUserSettings.mockResolvedValue({
      ...DEFAULTS,
      dashboardScope: dashboardScope.Group,
      dashboardGroupId: "group_1",
    });

    await handlePutMySettings(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("rejects group scope without a group", async () => {
    const { req, res } = makeReqRes({ body: { dashboardScope: dashboardScope.Group } });

    await expect(handlePutMySettings(req, res)).rejects.toMatchObject({ code: 422 });
    expect(mockUpsertUserSettings).not.toHaveBeenCalled();
  });

  it("rejects a group the caller may not view in full", async () => {
    const { req, res } = makeReqRes({
      body: { dashboardScope: dashboardScope.Group, dashboardGroupId: "group_1" },
    });
    mockGetScopeEntries.mockResolvedValue([scopeEntry("self")]);

    await expect(handlePutMySettings(req, res)).rejects.toMatchObject({ code: 403 });
    expect(mockUpsertUserSettings).not.toHaveBeenCalled();
  });

  it("clears the selected group without re-authorizing it", async () => {
    const { req, res } = makeReqRes({
      body: { dashboardScope: dashboardScope.Mine, dashboardGroupId: null },
    });
    mockUpsertUserSettings.mockResolvedValue(DEFAULTS);

    await handlePutMySettings(req, res);

    expect(mockGetScopeEntries).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

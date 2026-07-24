import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetUserSettings, mockUpsertUserSettings } = vi.hoisted(() => ({
  mockGetUserSettings: vi.fn(),
  mockUpsertUserSettings: vi.fn(),
}));

vi.mock("../../../middleware/authSession.js", () => ({
  getAuth: vi.fn(),
}));

vi.mock("../../../services/DBServices.js", () => ({
  createDBServices: () => ({
    userSettings: {
      getUserSettings: mockGetUserSettings,
      upsertUserSettings: mockUpsertUserSettings,
    },
  }),
}));

import { handleGetMySettings } from "../handleGetMySettings.js";
import { handlePutMySettings } from "../handlePutMySettings.js";
import { getAuth } from "../../../middleware/authSession.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";

describe("user settings endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthData);
  });

  it("defaults email notifications to on when the user has no stored settings", async () => {
    const { req, res } = makeReqRes();
    mockGetUserSettings.mockResolvedValue(undefined);

    await handleGetMySettings(req, res);

    expect(res.json).toHaveBeenCalledWith({ emailNotifications: true });
  });

  it("returns the stored preference", async () => {
    const { req, res } = makeReqRes();
    mockGetUserSettings.mockResolvedValue({ emailNotifications: false });

    await handleGetMySettings(req, res);

    expect(res.json).toHaveBeenCalledWith({ emailNotifications: false });
  });

  it("saves the preference for the authenticated user", async () => {
    const { req, res } = makeReqRes({ body: { emailNotifications: false } });
    mockUpsertUserSettings.mockResolvedValue({ emailNotifications: false });

    await handlePutMySettings(req, res);

    expect(mockUpsertUserSettings).toHaveBeenCalledWith(mockAuthData.userId, {
      emailNotifications: false,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ emailNotifications: false });
  });
});

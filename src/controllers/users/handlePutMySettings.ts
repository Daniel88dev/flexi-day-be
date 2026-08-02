import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import {
  DEFAULT_USER_SETTINGS,
  type UserSettingsPatch,
  type ValidatedPutUserSettingsType,
} from "../../services/userSettings/types.js";
import { dashboardScope } from "../../db/schema/user-settings-schema.js";
import { canViewWholeGroup } from "../../services/report/reportScope.js";
import AppError from "../../utils/appError.js";

const services = createDBServices();

export const handlePutMySettings = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data: ValidatedPutUserSettingsType = req.body;

  const current = await services.userSettings.getUserSettings(auth.userId);

  const patch: UserSettingsPatch = {};
  if (data.emailNotifications !== undefined) patch.emailNotifications = data.emailNotifications;
  if (data.dashboardScope !== undefined) patch.dashboardScope = data.dashboardScope;
  if (data.dashboardGroupId !== undefined) patch.dashboardGroupId = data.dashboardGroupId;

  // The patch is validated against the settings it produces, not against
  // itself: switching to GROUP scope may rely on a group chosen earlier.
  const nextScope =
    patch.dashboardScope ?? current?.dashboardScope ?? DEFAULT_USER_SETTINGS.dashboardScope;
  const nextGroupId =
    patch.dashboardGroupId !== undefined
      ? patch.dashboardGroupId
      : (current?.dashboardGroupId ?? DEFAULT_USER_SETTINGS.dashboardGroupId);

  if (nextScope === dashboardScope.Group && !nextGroupId) {
    throw new AppError({
      code: 422,
      message: "A group must be selected for group scope",
      logging: false,
    });
  }

  if (nextGroupId) {
    const scope = await services.report.getScopeEntries(auth.userId);
    if (!canViewWholeGroup(scope, nextGroupId)) {
      throw new AppError({
        code: 403,
        message: "No access to view this group's records",
        logging: true,
        context: { userId: auth.userId, groupId: nextGroupId },
      });
    }
  }

  const updated = await services.userSettings.upsertUserSettings(auth.userId, patch);

  if (!updated) {
    throw new AppError({
      message: "Failed to save settings",
      logging: true,
      code: 500,
      context: { userId: auth.userId, data },
    });
  }

  return res.status(200).json({
    emailNotifications: updated.emailNotifications,
    dashboardScope: updated.dashboardScope,
    dashboardGroupId: updated.dashboardGroupId,
  });
};

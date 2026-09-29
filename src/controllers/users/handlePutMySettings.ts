import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import {
  DEFAULT_USER_SETTINGS,
  type UserSettingsPatch,
} from "../../services/userSettings/types.js";
import { toUserSettingsResponse } from "../../services/userSettings/userSettingsResponse.js";
import { dashboardScope } from "../../db/schema/user-settings-schema.js";
import { canViewWholeGroup } from "../../services/report/reportScope.js";
import AppError from "../../utils/appError.js";
import { getScopeEntries } from "../../services/report/reportServices.js";
import {
  getUserSettings,
  upsertUserSettings,
} from "../../services/userSettings/userSettingsServices.js";

export const handlePutMySettings = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  // bodyValidationMiddleware replaced req.body with the parsed output, so keys
  // that are not settings are already stripped and absent ones stay absent.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const patch: UserSettingsPatch = req.body;

  const current = await getUserSettings(auth.userId);

  // Only a save that touches the scope or the group re-checks the group, so
  // another field still saves after the stored group has lost its view access.
  // The check runs against the settings the patch produces: switching to GROUP
  // scope may rely on a group chosen earlier.
  if (patch.dashboardScope !== undefined || patch.dashboardGroupId !== undefined) {
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
      const scope = await getScopeEntries(auth.userId);
      if (!canViewWholeGroup(scope, nextGroupId)) {
        throw new AppError({
          code: 403,
          message: "No access to view this group's records",
          logging: true,
          context: { userId: auth.userId, groupId: nextGroupId },
        });
      }
    }
  }

  const updated = await upsertUserSettings(auth.userId, patch);

  if (!updated) {
    throw new AppError({
      message: "Failed to save settings",
      logging: true,
      code: 500,
      context: { userId: auth.userId, data: patch },
    });
  }

  return res.status(200).json(toUserSettingsResponse(updated));
};

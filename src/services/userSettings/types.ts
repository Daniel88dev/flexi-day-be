import { z } from "zod";
import { dashboardScope } from "../../db/schema/user-settings-schema.js";

export type UserSettingsRecord = {
  userId: string;
  emailNotifications: boolean;
  dashboardScope: dashboardScope;
  dashboardGroupId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** What the settings endpoints expose — defaults applied, no timestamps. */
export type UserSettingsResponse = {
  emailNotifications: boolean;
  dashboardScope: dashboardScope;
  dashboardGroupId: string | null;
};

export const DEFAULT_USER_SETTINGS: UserSettingsResponse = {
  emailNotifications: true,
  dashboardScope: dashboardScope.Mine,
  dashboardGroupId: null,
};

/**
 * Every field is optional: the settings screen saves one card at a time, and
 * the handler merges the patch onto whatever is stored.
 */
export const validatePutUserSettings = z
  .object({
    emailNotifications: z.boolean().optional(),
    dashboardScope: z.enum(dashboardScope).optional(),
    dashboardGroupId: z.string().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one setting must be supplied",
  });

export type ValidatedPutUserSettingsType = z.infer<typeof validatePutUserSettings>;

export type UserSettingsPatch = {
  emailNotifications?: boolean;
  dashboardScope?: dashboardScope;
  dashboardGroupId?: string | null;
};

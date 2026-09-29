import { z } from "zod";
import {
  dashboardCalendarView,
  dashboardScope,
  type userSettings,
} from "../../db/schema/user-settings-schema.js";

export type UserSettingsRecord = typeof userSettings.$inferSelect;

/** What the settings endpoints expose: every preference column, no row id or timestamps. */
export type UserSettingsResponse = Omit<UserSettingsRecord, "userId" | "createdAt" | "updatedAt">;

export const DEFAULT_USER_SETTINGS: UserSettingsResponse = {
  emailNotifications: true,
  dashboardScope: dashboardScope.Mine,
  dashboardGroupId: null,
  dashboardCalendarView: dashboardCalendarView.Lanes,
  attendanceLocationNoticeDismissed: false,
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
    dashboardCalendarView: z.enum(dashboardCalendarView).optional(),
    attendanceLocationNoticeDismissed: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one setting must be supplied",
  });

export type ValidatedPutUserSettingsType = z.infer<typeof validatePutUserSettings>;

export type UserSettingsPatch = ValidatedPutUserSettingsType;

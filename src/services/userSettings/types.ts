import { z } from "zod";

export type UserSettingsRecord = {
  userId: string;
  emailNotifications: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/** What the settings endpoints expose — defaults applied, no timestamps. */
export type UserSettingsResponse = {
  emailNotifications: boolean;
};

export const DEFAULT_USER_SETTINGS: UserSettingsResponse = {
  emailNotifications: true,
};

export const validatePutUserSettings = z.object({
  emailNotifications: z.boolean(),
});

export type ValidatedPutUserSettingsType = z.infer<typeof validatePutUserSettings>;

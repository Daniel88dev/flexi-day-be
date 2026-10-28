import { DEFAULT_USER_SETTINGS, type UserSettingsResponse } from "./types.js";

const USER_SETTINGS_KEYS = Object.keys(DEFAULT_USER_SETTINGS) as (keyof UserSettingsResponse)[];

export const toUserSettingsResponse = (settings: UserSettingsResponse): UserSettingsResponse =>
  Object.fromEntries(USER_SETTINGS_KEYS.map((key) => [key, settings[key]])) as UserSettingsResponse;

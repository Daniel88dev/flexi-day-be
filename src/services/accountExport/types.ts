import type { UserSettingsResponse } from "../userSettings/types.js";

export const ACCOUNT_EXPORT_FORMAT = "flexi-day-account-export";
export const ACCOUNT_EXPORT_VERSION = 1;

/**
 * The Account export: account data Flexi Day holds as controller. Tokens, password hashes,
 * two-factor secrets and feed links never enter this shape.
 */
export type AccountExport = {
  format: typeof ACCOUNT_EXPORT_FORMAT;
  version: typeof ACCOUNT_EXPORT_VERSION;
  exportedAt: string;
  account: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image: string | null;
    twoFactorEnabled: boolean;
    createdAt: string;
    updatedAt: string;
  };
  signInMethods: {
    providerId: string;
    accountId: string;
    createdAt: string;
    updatedAt: string;
  }[];
  sessions: {
    current: boolean;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    ipAddress: string | null;
    userAgent: string | null;
    deviceId: string | null;
    platform: string | null;
    appVersion: string | null;
  }[];
  pushRegistrations: {
    environment: string;
    deviceId: string | null;
    platform: string | null;
    createdAt: string;
    updatedAt: string;
  }[];
  settings: UserSettingsResponse;
  birthday: {
    month: number | null;
    day: number | null;
    year: number | null;
    shared: boolean;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
  } | null;
  notifications: {
    type: string;
    title: string;
    body: string;
    href: string | null;
    readAt: string | null;
    createdAt: string;
  }[];
  calendarConnections: {
    provider: string;
    status: string;
    capability: string;
    grantedScopes: string;
    lastErrorAt: string | null;
    revokedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }[];
  calendarFeeds: {
    name: string;
    scope: string;
    timeZone: string;
    includeGroupEvents: boolean;
    includeBirthdays: boolean;
    syncsTo: string | null;
    lastFetchedAt: string | null;
    lastSyncedAt: string | null;
    deletedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }[];
};

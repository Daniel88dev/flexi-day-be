import { asc, eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { account, session, user } from "../../db/schema/auth-schema.js";
import { calendarConnection } from "../../db/schema/calendar-connection-schema.js";
import { calendarSync } from "../../db/schema/calendar-sync-schema.js";
import { notifications } from "../../db/schema/notification-schema.js";
import { pushRegistrations } from "../../db/schema/push-registration-schema.js";
import { userBirthdays } from "../../db/schema/user-birthday-schema.js";
import { userSettings } from "../../db/schema/user-settings-schema.js";
import AppError from "../../utils/appError.js";
import { DEFAULT_USER_SETTINGS } from "../userSettings/types.js";
import { toUserSettingsResponse } from "../userSettings/userSettingsResponse.js";
import { ACCOUNT_EXPORT_FORMAT, ACCOUNT_EXPORT_VERSION, type AccountExport } from "./types.js";

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null);

/**
 * Every query names its columns, so no token, password hash or secret is ever read, let alone
 * serialised. Runs in one read-only snapshot so the sections agree with each other.
 */
export const buildAccountExport = async (
  userId: string,
  currentSessionId: string,
  now: Date = new Date()
): Promise<AccountExport> =>
  db.transaction(
    async (tx) => {
      const [profile] = await tx
        .select({
          id: user.id,
          name: user.name,
          email: user.email,
          emailVerified: user.emailVerified,
          image: user.image,
          twoFactorEnabled: user.twoFactorEnabled,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        })
        .from(user)
        .where(eq(user.id, userId));
      if (!profile) throw new AppError({ code: 404, message: "Account not found" });

      const links = await tx
        .select({
          providerId: account.providerId,
          accountId: account.accountId,
          createdAt: account.createdAt,
          updatedAt: account.updatedAt,
        })
        .from(account)
        .where(eq(account.userId, userId))
        .orderBy(asc(account.createdAt));

      const sessions = await tx
        .select({
          id: session.id,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          expiresAt: session.expiresAt,
          ipAddress: session.ipAddress,
          userAgent: session.userAgent,
          deviceId: session.deviceId,
          platform: session.platform,
          appVersion: session.appVersion,
        })
        .from(session)
        .where(eq(session.userId, userId))
        .orderBy(asc(session.createdAt));

      const pushes = await tx
        .select({
          environment: pushRegistrations.environment,
          deviceId: session.deviceId,
          platform: session.platform,
          createdAt: pushRegistrations.createdAt,
          updatedAt: pushRegistrations.updatedAt,
        })
        .from(pushRegistrations)
        .innerJoin(session, eq(session.id, pushRegistrations.sessionId))
        .where(eq(session.userId, userId))
        .orderBy(asc(pushRegistrations.createdAt));

      const [settings] = await tx
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, userId));

      const [birthday] = await tx
        .select({
          month: userBirthdays.month,
          day: userBirthdays.day,
          year: userBirthdays.year,
          shared: userBirthdays.shared,
          createdAt: userBirthdays.createdAt,
          updatedAt: userBirthdays.updatedAt,
          deletedAt: userBirthdays.deletedAt,
        })
        .from(userBirthdays)
        .where(eq(userBirthdays.userId, userId));

      const notices = await tx
        .select({
          type: notifications.type,
          title: notifications.title,
          body: notifications.body,
          href: notifications.href,
          readAt: notifications.readAt,
          createdAt: notifications.createdAt,
        })
        .from(notifications)
        .where(eq(notifications.userId, userId))
        .orderBy(asc(notifications.createdAt));

      const connections = await tx
        .select({
          provider: calendarConnection.provider,
          status: calendarConnection.status,
          capability: calendarConnection.capability,
          grantedScopes: calendarConnection.grantedScopes,
          lastErrorAt: calendarConnection.lastErrorAt,
          revokedAt: calendarConnection.revokedAt,
          createdAt: calendarConnection.createdAt,
          updatedAt: calendarConnection.updatedAt,
        })
        .from(calendarConnection)
        .where(eq(calendarConnection.userId, userId))
        .orderBy(asc(calendarConnection.createdAt));

      const feeds = await tx
        .select({
          name: calendarSync.name,
          scope: calendarSync.scope,
          timeZone: calendarSync.timeZone,
          includeGroupEvents: calendarSync.includeGroupEvents,
          includeBirthdays: calendarSync.includeBirthdays,
          syncsTo: calendarConnection.provider,
          lastFetchedAt: calendarSync.lastFetchedAt,
          lastSyncedAt: calendarSync.lastSyncedAt,
          deletedAt: calendarSync.deletedAt,
          createdAt: calendarSync.createdAt,
          updatedAt: calendarSync.updatedAt,
        })
        .from(calendarSync)
        .leftJoin(calendarConnection, eq(calendarConnection.id, calendarSync.connectionId))
        .where(eq(calendarSync.userId, userId))
        .orderBy(asc(calendarSync.createdAt));

      return {
        format: ACCOUNT_EXPORT_FORMAT,
        version: ACCOUNT_EXPORT_VERSION,
        exportedAt: iso(now),
        account: {
          ...profile,
          twoFactorEnabled: profile.twoFactorEnabled ?? false,
          createdAt: iso(profile.createdAt),
          updatedAt: iso(profile.updatedAt),
        },
        signInMethods: links.map((link) => ({
          ...link,
          createdAt: iso(link.createdAt),
          updatedAt: iso(link.updatedAt),
        })),
        sessions: sessions.map(({ id, ...row }) => ({
          current: id === currentSessionId,
          ...row,
          createdAt: iso(row.createdAt),
          updatedAt: iso(row.updatedAt),
          expiresAt: iso(row.expiresAt),
        })),
        pushRegistrations: pushes.map((row) => ({
          ...row,
          createdAt: iso(row.createdAt),
          updatedAt: iso(row.updatedAt),
        })),
        settings: toUserSettingsResponse(settings ?? DEFAULT_USER_SETTINGS),
        birthday: birthday
          ? {
              ...birthday,
              createdAt: iso(birthday.createdAt),
              updatedAt: iso(birthday.updatedAt),
              deletedAt: isoOrNull(birthday.deletedAt),
            }
          : null,
        notifications: notices.map((row) => ({
          ...row,
          readAt: isoOrNull(row.readAt),
          createdAt: iso(row.createdAt),
        })),
        calendarConnections: connections.map((row) => ({
          ...row,
          lastErrorAt: isoOrNull(row.lastErrorAt),
          revokedAt: isoOrNull(row.revokedAt),
          createdAt: iso(row.createdAt),
          updatedAt: iso(row.updatedAt),
        })),
        calendarFeeds: feeds.map((row) => ({
          ...row,
          lastFetchedAt: isoOrNull(row.lastFetchedAt),
          lastSyncedAt: isoOrNull(row.lastSyncedAt),
          deletedAt: isoOrNull(row.deletedAt),
          createdAt: iso(row.createdAt),
          updatedAt: iso(row.updatedAt),
        })),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" }
  );

/** `flexi-day-account-2026-10-25.json`, dated in UTC. */
export const accountExportFilename = (now: Date): string =>
  `flexi-day-account-${now.toISOString().slice(0, 10)}.json`;

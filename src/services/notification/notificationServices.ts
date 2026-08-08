import { db, type DbTransaction } from "../../db/db.js";
import { notifications } from "../../db/schema/notification-schema.js";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { NotificationInsertType, NotificationRecord } from "./types.js";

/**
 * Lists notifications for a user, optionally limiting to unread ones, ordered
 * newest first.
 */
export const listNotificationsForUser = async (
  userId: string,
  unreadOnly: boolean
): Promise<NotificationRecord[]> => {
  const where = unreadOnly
    ? and(eq(notifications.userId, userId), isNull(notifications.readAt))
    : eq(notifications.userId, userId);

  return db.select().from(notifications).where(where).orderBy(desc(notifications.createdAt));
};

/**
 * Marks a notification as read. Only updates rows whose `readAt` is still
 * NULL, so the original first-read timestamp is preserved when the endpoint
 * is hit again. Returns undefined when nothing matched — that can mean the
 * row does not exist, the caller does not own it, or it was already read.
 * Use `getNotificationForUser` to disambiguate.
 */
export const markNotificationRead = async (
  notificationId: string,
  userId: string,
  tx?: DbTransaction
): Promise<NotificationRecord | undefined> => {
  const [row] = await (tx ?? db)
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.userId, userId),
        isNull(notifications.readAt)
      )
    )
    .returning();

  return row;
};

/**
 * Fetches a single notification row owned by the given user, regardless of
 * read state. Used to distinguish "not found" from "already read" on the
 * mark-read endpoint.
 */
export const getNotificationForUser = async (
  notificationId: string,
  userId: string,
  tx?: DbTransaction
): Promise<NotificationRecord | undefined> => {
  const [row] = await (tx ?? db)
    .select()
    .from(notifications)
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)));
  return row;
};

/**
 * Marks every unread notification of a user as read. Scoped to `readAt IS
 * NULL` so notifications read earlier keep their original timestamp. Returns
 * how many rows were flipped.
 */
export const markAllNotificationsRead = async (
  userId: string,
  tx?: DbTransaction
): Promise<number> => {
  const rows = await (tx ?? db)
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });

  return rows.length;
};

/**
 * Deletes a single notification. The owner predicate is part of the WHERE
 * clause, so a foreign id simply matches nothing. Returns undefined when
 * nothing was deleted, which the controller reports as 404.
 */
export const deleteNotificationForUser = async (
  notificationId: string,
  userId: string,
  tx?: DbTransaction
): Promise<NotificationRecord | undefined> => {
  const [row] = await (tx ?? db)
    .delete(notifications)
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
    .returning();

  return row;
};

/**
 * Deletes every notification of a user. Returns how many rows went.
 */
export const deleteAllNotificationsForUser = async (
  userId: string,
  tx?: DbTransaction
): Promise<number> => {
  const rows = await (tx ?? db)
    .delete(notifications)
    .where(eq(notifications.userId, userId))
    .returning({ id: notifications.id });

  return rows.length;
};

/**
 * Inserts a notification row. Used by future workflow code; kept in the same
 * service module so all notification persistence lives in one place.
 */
export const createNotification = async (
  record: NotificationInsertType,
  tx?: DbTransaction
): Promise<NotificationRecord | undefined> => {
  const [row] = await (tx ?? db).insert(notifications).values(record).returning();
  return row;
};

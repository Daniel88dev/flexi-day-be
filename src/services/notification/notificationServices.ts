import { db, type DbTransaction } from "../../db/db.js";
import { notifications } from "../../db/schema/notification-schema.js";
import { and, desc, eq, isNull } from "drizzle-orm";
import type {
  NotificationInsertType,
  NotificationRecord,
} from "./types.js";

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

  return db
    .select()
    .from(notifications)
    .where(where)
    .orderBy(desc(notifications.createdAt));
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
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.userId, userId)
      )
    );
  return row;
};

/**
 * Inserts a notification row. Used by future workflow code; kept in the same
 * service module so all notification persistence lives in one place.
 */
export const createNotification = async (
  record: NotificationInsertType,
  tx?: DbTransaction
): Promise<NotificationRecord | undefined> => {
  const [row] = await (tx ?? db)
    .insert(notifications)
    .values(record)
    .returning();
  return row;
};

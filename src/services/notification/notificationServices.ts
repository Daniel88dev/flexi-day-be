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
 * Marks a notification as read for the given user. Returns the updated row,
 * or undefined when the user does not own a matching unread notification.
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
        eq(notifications.userId, userId)
      )
    )
    .returning();

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

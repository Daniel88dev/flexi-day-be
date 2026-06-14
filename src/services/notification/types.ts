import { z } from "zod";
import { notificationType } from "../../db/schema/notification-schema.js";

export type NotificationRecord = {
  id: string;
  userId: string;
  type: notificationType;
  title: string;
  body: string;
  href: string | null;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type NotificationInsertType = Pick<
  NotificationRecord,
  "id" | "userId" | "type" | "title" | "body"
> & {
  href?: string | null;
};

export const validateNotificationListQuery = z.object({
  unreadOnly: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((value) => value === true || value === "true")
    .optional(),
});

export type ValidatedNotificationListQuery = z.infer<
  typeof validateNotificationListQuery
>;

import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import { validateNotificationListQuery } from "../../services/notification/types.js";

const services = createDBServices();

export const handleGetNotifications = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const { unreadOnly } = validateNotificationListQuery.parse(req.query);

  const rows = await services.notification.listNotificationsForUser(
    auth.userId,
    Boolean(unreadOnly)
  );

  return res.status(200).json(
    rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      href: row.href,
      readAt: row.readAt ? row.readAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    }))
  );
};

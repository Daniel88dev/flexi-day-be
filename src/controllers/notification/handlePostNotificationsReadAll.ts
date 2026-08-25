import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { markAllNotificationsRead } from "../../services/notification/notificationServices.js";

export const handlePostNotificationsReadAll = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const updated = await markAllNotificationsRead(auth.userId);

  return res.status(200).json({ message: "Notifications marked as read", updated });
};

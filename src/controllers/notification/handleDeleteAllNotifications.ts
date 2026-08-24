import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { deleteAllNotificationsForUser } from "../../services/notification/notificationServices.js";

export const handleDeleteAllNotifications = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const removed = await deleteAllNotificationsForUser(auth.userId);

  return res.status(200).json({ message: "Notifications cleared", removed });
};

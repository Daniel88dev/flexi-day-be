import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";

const services = createDBServices();

export const handleDeleteAllNotifications = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const removed = await services.notification.deleteAllNotificationsForUser(auth.userId);

  return res.status(200).json({ message: "Notifications cleared", removed });
};

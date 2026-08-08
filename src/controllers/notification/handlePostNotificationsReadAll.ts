import type { Request, Response } from "express";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";

const services = createDBServices();

export const handlePostNotificationsReadAll = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const updated = await services.notification.markAllNotificationsRead(auth.userId);

  return res.status(200).json({ message: "Notifications marked as read", updated });
};

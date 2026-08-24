import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { deleteNotificationForUser } from "../../services/notification/notificationServices.js";

const validateUUID = z.uuid();

export const handleDeleteNotification = async (req: Request, res: Response) => {
  const auth = getAuth(req);

  const notificationId = validateUUID.parse(req.params.id);

  const deleted = await deleteNotificationForUser(notificationId, auth.userId);

  if (!deleted) {
    throw new AppError({
      code: 404,
      message: "Notification not found",
      context: { auth, notificationId },
    });
  }

  return res.status(200).json({ message: "Notification removed" });
};

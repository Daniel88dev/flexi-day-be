import type { Request, Response } from "express";
import { z } from "zod";
import { getAuth } from "../../middleware/authSession.js";
import { createDBServices } from "../../services/DBServices.js";
import AppError from "../../utils/appError.js";

const services = createDBServices();

const validateUUID = z.uuid();

export const handlePostNotificationRead = async (
  req: Request,
  res: Response
) => {
  const auth = getAuth(req);

  const notificationId = validateUUID.parse(req.params.id);

  const updated = await services.notification.markNotificationRead(
    notificationId,
    auth.userId
  );

  if (updated) {
    return res.status(200).json({ message: "Notification marked as read" });
  }

  // Update returned nothing: either the row doesn't exist for this user, or
  // it was already read. The endpoint is logically idempotent, so treat
  // "already read" as success and preserve the original `readAt`.
  const existing = await services.notification.getNotificationForUser(
    notificationId,
    auth.userId
  );

  if (!existing) {
    throw new AppError({
      code: 404,
      message: "Notification not found",
      context: { auth, notificationId },
    });
  }

  return res.status(200).json({ message: "Notification already read" });
};

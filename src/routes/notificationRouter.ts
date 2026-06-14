import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetNotifications } from "../controllers/notification/handleGetNotifications.js";
import { handlePostNotificationRead } from "../controllers/notification/handlePostNotificationRead.js";

export const notificationRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/notifications:
   *   get:
   *     tags:
   *       - Notifications
   *     summary: List notifications for the caller
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: unreadOnly
   *         in: query
   *         required: false
   *         schema:
   *           type: boolean
   *     responses:
   *       '200':
   *         description: Array of notifications
   */
  app.get("/", tryCatch(handleGetNotifications));

  /**
   * @openapi
   * /api/notifications/{id}/read:
   *   post:
   *     tags:
   *       - Notifications
   *     summary: Mark a notification as read
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       '200':
   *         description: Notification marked as read
   *       '404':
   *         description: Notification not found
   */
  app.post("/:id/read", tryCatch(handlePostNotificationRead));

  return app;
};

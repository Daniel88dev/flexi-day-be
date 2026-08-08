import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetNotifications } from "../controllers/notification/handleGetNotifications.js";
import { handlePostNotificationRead } from "../controllers/notification/handlePostNotificationRead.js";
import { handlePostNotificationsReadAll } from "../controllers/notification/handlePostNotificationsReadAll.js";
import { handleDeleteNotification } from "../controllers/notification/handleDeleteNotification.js";
import { handleDeleteAllNotifications } from "../controllers/notification/handleDeleteAllNotifications.js";

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

  /**
   * @openapi
   * /api/notifications/read-all:
   *   post:
   *     tags:
   *       - Notifications
   *     summary: Mark every unread notification of the caller as read
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Number of notifications that were marked as read
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                 updated:
   *                   type: integer
   */
  app.post("/read-all", tryCatch(handlePostNotificationsReadAll));

  /**
   * @openapi
   * /api/notifications/{id}:
   *   delete:
   *     tags:
   *       - Notifications
   *     summary: Remove a single notification of the caller
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
   *         description: Notification removed
   *       '404':
   *         description: Notification not found
   */
  app.delete("/:id", tryCatch(handleDeleteNotification));

  /**
   * @openapi
   * /api/notifications:
   *   delete:
   *     tags:
   *       - Notifications
   *     summary: Remove every notification of the caller
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Number of notifications that were removed
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                 removed:
   *                   type: integer
   */
  app.delete("/", tryCatch(handleDeleteAllNotifications));

  return app;
};

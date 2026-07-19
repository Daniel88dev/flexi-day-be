import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetCalendars } from "../controllers/calendarSync/handleGetCalendars.js";
import { handleGetCalendar } from "../controllers/calendarSync/handleGetCalendar.js";
import { handlePostCalendar } from "../controllers/calendarSync/handlePostCalendar.js";
import { handleUpdateCalendar } from "../controllers/calendarSync/handleUpdateCalendar.js";
import { handleDeleteCalendar } from "../controllers/calendarSync/handleDeleteCalendar.js";
import { handleRegenerateToken } from "../controllers/calendarSync/handleRegenerateToken.js";

export const calendarSyncRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/calendar-sync:
   *   get:
   *     tags:
   *       - Calendar sync
   *     summary: List the caller's calendar-sync feeds (feed tokens masked)
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: Array of calendar-sync configs
   */
  app.get("/", tryCatch(handleGetCalendars));

  /**
   * @openapi
   * /api/calendar-sync:
   *   post:
   *     tags:
   *       - Calendar sync
   *     summary: Create a calendar-sync feed
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - name
   *               - types
   *             properties:
   *               name:
   *                 type: string
   *                 minLength: 1
   *                 maxLength: 120
   *               scope:
   *                 type: string
   *                 enum: [ME, TEAM]
   *                 default: ME
   *               distinguishMine:
   *                 type: boolean
   *                 default: false
   *               teamIds:
   *                 type: array
   *                 items:
   *                   type: string
   *                   format: uuid
   *               types:
   *                 type: array
   *                 minItems: 1
   *                 items:
   *                   type: object
   *                   required:
   *                     - type
   *                     - color
   *                   properties:
   *                     type:
   *                       type: string
   *                     color:
   *                       type: string
   *                       description: Swatch palette key (e.g. "violet")
   *                     mineColor:
   *                       type: string
   *     responses:
   *       '201':
   *         description: The created config, including its full feed URL
   *       '403':
   *         description: A requested team is not one the caller belongs to
   */
  app.post("/", tryCatch(handlePostCalendar));

  /**
   * @openapi
   * /api/calendar-sync/{id}:
   *   get:
   *     tags:
   *       - Calendar sync
   *     summary: Get a single calendar-sync feed with its full feed URL
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
   *         description: The config
   *       '404':
   *         description: Calendar not found
   */
  app.get("/:id", tryCatch(handleGetCalendar));

  /**
   * @openapi
   * /api/calendar-sync/{id}:
   *   put:
   *     tags:
   *       - Calendar sync
   *     summary: Replace a calendar-sync feed's settings, teams and types
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - name
   *               - types
   *             properties:
   *               name:
   *                 type: string
   *                 minLength: 1
   *                 maxLength: 120
   *               scope:
   *                 type: string
   *                 enum: [ME, TEAM]
   *                 default: ME
   *               distinguishMine:
   *                 type: boolean
   *                 default: false
   *               teamIds:
   *                 type: array
   *                 items:
   *                   type: string
   *                   format: uuid
   *               types:
   *                 type: array
   *                 minItems: 1
   *                 items:
   *                   type: object
   *                   required:
   *                     - type
   *                     - color
   *                   properties:
   *                     type:
   *                       type: string
   *                     color:
   *                       type: string
   *                       description: Swatch palette key (e.g. "violet")
   *                     mineColor:
   *                       type: string
   *     responses:
   *       '200':
   *         description: The updated config
   *       '404':
   *         description: Calendar not found
   */
  app.put("/:id", tryCatch(handleUpdateCalendar));

  /**
   * @openapi
   * /api/calendar-sync/{id}:
   *   delete:
   *     tags:
   *       - Calendar sync
   *     summary: Delete a calendar-sync feed
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
   *         description: Calendar deleted
   *       '404':
   *         description: Calendar not found
   */
  app.delete("/:id", tryCatch(handleDeleteCalendar));

  /**
   * @openapi
   * /api/calendar-sync/{id}/regenerate-token:
   *   post:
   *     tags:
   *       - Calendar sync
   *     summary: Rotate the feed token, revoking the previous link
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
   *         description: The config with a new feed URL
   *       '404':
   *         description: Calendar not found
   */
  app.post("/:id/regenerate-token", tryCatch(handleRegenerateToken));

  return app;
};

import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { handleGetBirthdays } from "../controllers/birthday/handleGetBirthdays.js";

export const birthdayRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/birthdays:
   *   get:
   *     tags:
   *       - Birthdays
   *     summary: Retrieve the birthdays the dashboard calendar draws for a month plus 6 days either side
   *     description: |
   *       Returns the birthdays falling from 6 days before the 1st of the month
   *       through 6 days after its last day, the window of
   *       `GET /api/vacation/calendar`. The window crosses a year boundary as
   *       needed: December 2026 reaches 6 January 2027.
   *
   *       Without `groupId` (Mine scope) only the caller's own birthday is
   *       returned, shared or not. With `groupId` (Group scope) the caller's
   *       own birthday comes with the shared birthdays of the group's live
   *       members, when the group's organization is on a paid plan or has
   *       lapsed from one; a group whose organization never paid shows none.
   *       Group scope requires seeing the group in full, as
   *       `GET /api/vacation` does: view access, admin access, being its
   *       manager, or administering it through its organization. A plain
   *       member or an outsider gets a 403. Shared birthdays reach only
   *       fellow members: someone who administers the group without belonging
   *       to it gets a 200 with their own birthday alone.
   *
   *       Each row is one person's birthday on the day it falls in the window.
   *       A birthday on 29 February falls on 28 February in a non-leap year.
   *       `age` is the age turned that day when the person saved a year, and
   *       null otherwise. A removed birthday never shows. Rows are ordered by
   *       `date`, then by name.
   *     operationId: handleGetBirthdays
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: year
   *         in: query
   *         required: true
   *         schema:
   *           type: integer
   *           minimum: 2023
   *           maximum: 2050
   *       - name: month
   *         in: query
   *         required: true
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 12
   *       - name: groupId
   *         in: query
   *         required: false
   *         description: Return this group's birthdays as well as the caller's own.
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       '200':
   *         description: The birthdays in the padded window
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 required: [userId, user, date, month, day, year, age]
   *                 properties:
   *                   userId:
   *                     type: string
   *                   user:
   *                     type: object
   *                     description: The person, as the calendar labels them
   *                     properties:
   *                       id:
   *                         type: string
   *                       name:
   *                         type: string
   *                       initials:
   *                         type: string
   *                       avatarColor:
   *                         type: string
   *                   date:
   *                     type: string
   *                     format: date
   *                     description: The day the birthday falls on in the window
   *                   month:
   *                     type: integer
   *                     minimum: 1
   *                     maximum: 12
   *                     description: The saved month
   *                   day:
   *                     type: integer
   *                     minimum: 1
   *                     maximum: 31
   *                     description: The saved day, 29 for a 29 February birthday in any year
   *                   year:
   *                     type: integer
   *                     nullable: true
   *                     description: The saved birth year, null when the person left it out
   *                   age:
   *                     type: integer
   *                     nullable: true
   *                     description: The age turned on `date`; null without a year
   *       '401':
   *         description: Unauthorized
   *       '403':
   *         description: |
   *           No access to view this group's records: the caller neither sees the
   *           group in full as a member nor administers it
   *       '422':
   *         description: Missing or out-of-range `year` or `month`
   *       '500':
   *         description: Internal Server Error
   */
  app.get("/", tryCatch(handleGetBirthdays));

  return app;
};

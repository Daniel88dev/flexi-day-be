import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { validateCreateGroupEvent } from "../services/groupEvent/types.js";
import { handleGetGroupEvents } from "../controllers/groupEvent/handleGetGroupEvents.js";
import { handleGetGroupEventGroups } from "../controllers/groupEvent/handleGetGroupEventGroups.js";
import { handlePostGroupEvent } from "../controllers/groupEvent/handlePostGroupEvent.js";

export const groupEventRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * components:
   *   schemas:
   *     GroupEventRepeatRule:
   *       type: object
   *       description: |
   *         The rule of a recurring group event. Clients expand it into
   *         occurrences themselves. A day the month lacks lands on its last
   *         day: monthly on the 31st falls on the 30th or 28th/29th, yearly on
   *         29 February on 28 February.
   *       required: [freq, interval, weekdays, monthlyMode, until]
   *       properties:
   *         freq:
   *           type: string
   *           enum: [daily, weekly, monthly, yearly]
   *         interval:
   *           type: integer
   *           minimum: 1
   *           maximum: 99
   *           description: Every N days, weeks, months or years.
   *         weekdays:
   *           type: array
   *           description: |
   *             Weekly only, sorted, always holding the start date's weekday;
   *             empty for other rules. 0 = Monday … 6 = Sunday.
   *           items:
   *             type: integer
   *             minimum: 0
   *             maximum: 6
   *         monthlyMode:
   *           type: string
   *           nullable: true
   *           enum: [day, weekday, lastWeekday]
   *           description: |
   *             Monthly only, read off the start date: `day` repeats on its day
   *             of the month, `weekday` on its 1st to 4th weekday, `lastWeekday`
   *             on the last such weekday. Null for other rules.
   *         until:
   *           type: string
   *           format: date
   *           nullable: true
   *           description: Last day it may fall on, inclusive. Null repeats forever.
   *     GroupEvent:
   *       type: object
   *       required: [id, groupId, groupName, title, note, startDate, endDate, startTime, endTime, repeat, skippedDates, recurringEventId, originalDate, createdBy, canEdit, createdAt, updatedAt]
   *       properties:
   *         id:
   *           type: string
   *           format: uuid
   *         groupId:
   *           type: string
   *           format: uuid
   *         groupName:
   *           type: string
   *         title:
   *           type: string
   *           minLength: 1
   *           maxLength: 100
   *         note:
   *           type: string
   *           nullable: true
   *           maxLength: 1000
   *         startDate:
   *           type: string
   *           format: date
   *         endDate:
   *           type: string
   *           format: date
   *           description: Inclusive. Equals `startDate` on a recurring group event.
   *         startTime:
   *           type: string
   *           nullable: true
   *           example: "09:30"
   *           description: |
   *             `HH:MM` wall-clock time, no zone. Null with `endTime` on an
   *             all-day event. A timed event over several days is one span from
   *             `startDate` `startTime` to `endDate` `endTime`.
   *         endTime:
   *           type: string
   *           nullable: true
   *           example: "10:00"
   *         repeat:
   *           allOf:
   *             - $ref: '#/components/schemas/GroupEventRepeatRule'
   *           nullable: true
   *           description: Null on a one-off.
   *         skippedDates:
   *           type: array
   *           description: Occurrences the rule produces that do not happen, sorted.
   *           items:
   *             type: string
   *             format: date
   *         recurringEventId:
   *           type: string
   *           format: uuid
   *           nullable: true
   *           description: |
   *             Set on a one-off that replaced one occurrence of that recurring
   *             group event, whose `skippedDates` then hold `originalDate`.
   *         originalDate:
   *           type: string
   *           format: date
   *           nullable: true
   *         createdBy:
   *           nullable: true
   *           description: Null once the creator deleted their account.
   *           type: object
   *           required: [id, name, initials, avatarColor]
   *           properties:
   *             id:
   *               type: string
   *             name:
   *               type: string
   *             initials:
   *               type: string
   *             avatarColor:
   *               type: string
   *         canEdit:
   *           type: boolean
   *           description: |
   *             Whether the caller may edit or delete it: its creator while
   *             still a member of the group, or a group admin.
   *         createdAt:
   *           type: string
   *           format: date-time
   *         updatedAt:
   *           type: string
   *           format: date-time
   *
   * /api/group-events:
   *   get:
   *     tags:
   *       - Group events
   *     summary: Retrieve the group events of a month plus 6 days either side
   *     description: |
   *       Returns the live group events with at least one day from 6 days
   *       before the 1st of the month through 6 days after its last day, the
   *       window of `GET /api/vacation/calendar`. A recurring group event is
   *       one row carrying its rule and skipped dates, whatever month it
   *       started in; the client expands it. A one-off made by a "this event"
   *       edit is a row of its own.
   *
   *       Without `groupId`, the events of every group the caller is a live
   *       member of. With it, that group's events, for a member of any kind
   *       or a group admin (an org admin who is not a member included).
   *       Never gated on the plan: a lapsed group keeps listing its events.
   *       At most 500 rows are read per call.
   *     operationId: handleGetGroupEvents
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
   *         description: Return only this group's events.
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       '200':
   *         description: Group events in the padded window, ordered by start date
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               maxItems: 500
   *               items:
   *                 $ref: '#/components/schemas/GroupEvent'
   *       '401':
   *         description: Unauthorized
   *       '403':
   *         description: Not a member of the group and not its admin
   *       '404':
   *         description: No such live group
   *       '422':
   *         description: Missing or out-of-range `year` or `month`, or a `groupId` that is not a UUID
   *       '500':
   *         description: Internal Server Error
   */
  app.get("/", tryCatch(handleGetGroupEvents));

  /**
   * @openapi
   * /api/group-events/groups:
   *   get:
   *     tags:
   *       - Group events
   *     summary: List the groups the caller may add group events to
   *     description: |
   *       Every live group the caller is a member of or administers, ordered
   *       by name. `canCreate` is true when a `POST /api/group-events` for it
   *       would pass now: the caller holds a membership of any kind or
   *       administers the group, and its organization is on a paid plan
   *       (Pro, Enterprise or Custom, grace included). Clients show every
   *       create entry from this flag and never from a 402.
   *     operationId: handleGetGroupEventGroups
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: The caller's groups
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 required: [groupId, groupName, canCreate]
   *                 properties:
   *                   groupId:
   *                     type: string
   *                     format: uuid
   *                   groupName:
   *                     type: string
   *                   canCreate:
   *                     type: boolean
   *       '401':
   *         description: Unauthorized
   *       '500':
   *         description: Internal Server Error
   */
  app.get("/groups", tryCatch(handleGetGroupEventGroups));

  /**
   * @openapi
   * /api/group-events:
   *   post:
   *     tags:
   *       - Group events
   *     summary: Create a group event
   *     description: |
   *       Adds a one-off or recurring group event to one group's calendar.
   *       Any live member of the group may create, view-only included, and so
   *       may a group admin who is not a member. The group's organization must
   *       be on a paid plan. Times are wall-clock with no zone; each feed and
   *       sync target stamps its own.
   *     operationId: handlePostGroupEvent
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [groupId, title, startDate]
   *             properties:
   *               groupId:
   *                 type: string
   *                 format: uuid
   *               title:
   *                 type: string
   *                 minLength: 1
   *                 maxLength: 100
   *                 description: Trimmed before the length check.
   *               note:
   *                 type: string
   *                 nullable: true
   *                 maxLength: 1000
   *                 description: Trimmed; a blank note is stored as none.
   *               startDate:
   *                 type: string
   *                 format: date
   *               endDate:
   *                 type: string
   *                 format: date
   *                 description: Inclusive, on or after `startDate`. Defaults to `startDate`.
   *               startTime:
   *                 type: string
   *                 nullable: true
   *                 pattern: '^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$'
   *                 description: |
   *                   `HH:MM` (seconds accepted and dropped). Give both times or
   *                   neither; neither is all-day. On a single day `endTime`
   *                   must be later than `startTime`.
   *               endTime:
   *                 type: string
   *                 nullable: true
   *                 pattern: '^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$'
   *               repeat:
   *                 type: object
   *                 nullable: true
   *                 description: |
   *                   Makes it a recurring group event, which lasts one day
   *                   (`endDate` equal to `startDate`). `weekdays` must hold the
   *                   start date's weekday on a weekly rule and is ignored on
   *                   others. `monthlyMode` is required on a monthly rule and
   *                   ignored on others: `weekday` needs a start on the 1st to
   *                   4th such weekday of its month, `lastWeekday` a start on the
   *                   last one.
   *                 required: [freq, interval]
   *                 properties:
   *                   freq:
   *                     type: string
   *                     enum: [daily, weekly, monthly, yearly]
   *                   interval:
   *                     type: integer
   *                     minimum: 1
   *                     maximum: 99
   *                   weekdays:
   *                     type: array
   *                     items:
   *                       type: integer
   *                       minimum: 0
   *                       maximum: 6
   *                   monthlyMode:
   *                     type: string
   *                     nullable: true
   *                     enum: [day, weekday, lastWeekday]
   *                   until:
   *                     type: string
   *                     format: date
   *                     nullable: true
   *                     description: Inclusive, on or after `startDate`.
   *     responses:
   *       '201':
   *         description: The created group event
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/GroupEvent'
   *       '401':
   *         description: Unauthorized
   *       '402':
   *         description: |
   *           The group's organization is not on a paid plan, never paid or
   *           lapsed. `context` is
   *           `{ reason: "PLAN_LIMIT", code: "GROUP_EVENTS_PLAN_REQUIRED" }`.
   *       '403':
   *         description: Not a member of the group and not its admin
   *       '404':
   *         description: No such live group
   *       '422':
   *         description: |
   *           Invalid body: a blank or over-long title, an end before the
   *           start, one time without the other, a single-day end at or before
   *           its start, a repeat rule on a multi-day event, or a rule the
   *           start date cannot carry.
   *       '500':
   *         description: Internal Server Error
   */
  app.post("/", bodyValidationMiddleware(validateCreateGroupEvent), tryCatch(handlePostGroupEvent));

  return app;
};

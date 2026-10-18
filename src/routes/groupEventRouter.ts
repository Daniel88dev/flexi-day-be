import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import { validateCreateGroupEvent, validatePatchGroupEvent } from "../services/groupEvent/types.js";
import { handleGetGroupEvents } from "../controllers/groupEvent/handleGetGroupEvents.js";
import { handleGetGroupEventGroups } from "../controllers/groupEvent/handleGetGroupEventGroups.js";
import { handlePostGroupEvent } from "../controllers/groupEvent/handlePostGroupEvent.js";
import { handlePatchGroupEvent } from "../controllers/groupEvent/handlePatchGroupEvent.js";
import { handleGetGroupEventImpact } from "../controllers/groupEvent/handleGetGroupEventImpact.js";
import { handleDeleteGroupEvent } from "../controllers/groupEvent/handleDeleteGroupEvent.js";

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

  /**
   * @openapi
   * components:
   *   schemas:
   *     GroupEventChanges:
   *       type: object
   *       description: |
   *         What an edit changes. A missing field keeps its value; `null`
   *         clears `note`, makes the event all-day when given for both times,
   *         and turns repeat off for `repeat`. A moved `startDate` without an
   *         `endDate` keeps the event's length. The result must pass every
   *         rule `POST /api/group-events` applies.
   *
   *         Per scope on a recurring group event: with `this`, `startDate`
   *         moves the one occurrence and `repeat` must be absent or the
   *         current rule; with `following`, `startDate` defaults to
   *         `occurrenceDate` and is the new event's first day; with `all`,
   *         `startDate` is the recurring group event's first day, not the
   *         occurrence's.
   *       properties:
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
   *         startTime:
   *           type: string
   *           nullable: true
   *           pattern: '^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$'
   *         endTime:
   *           type: string
   *           nullable: true
   *           pattern: '^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$'
   *         repeat:
   *           nullable: true
   *           description: The whole new rule, as on create. `null` turns repeat off.
   *           allOf:
   *             - $ref: '#/components/schemas/GroupEventRepeatRule'
   *     GroupEventWriteResult:
   *       type: object
   *       required: [droppedOneOffs, events, deletedIds]
   *       properties:
   *         droppedOneOffs:
   *           type: integer
   *           minimum: 0
   *           description: |
   *             One-off changes the request dropped: linked one-offs it deleted
   *             plus skipped dates it cleared that no one-off stood for. Always
   *             0 on a delete.
   *         events:
   *           type: array
   *           description: Every live row the request edited or created.
   *           items:
   *             $ref: '#/components/schemas/GroupEvent'
   *         deletedIds:
   *           type: array
   *           description: Rows the request deleted.
   *           items:
   *             type: string
   *             format: uuid
   *
   * /api/group-events/{id}/impact:
   *   get:
   *     tags:
   *       - Group events
   *     summary: Count the one-off changes an edit would drop
   *     description: |
   *       A dry run of `PATCH /api/group-events/{id}` with the same inputs,
   *       for the warning before an edit that drops one-off changes. Writes
   *       nothing and answers the `droppedOneOffs` the PATCH would answer.
   *       Refuses what the PATCH would refuse, except the plan check.
   *     operationId: handleGetGroupEventImpact
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *       - name: scope
   *         in: query
   *         required: false
   *         description: Required for a recurring group event, ignored on a one-off.
   *         schema:
   *           type: string
   *           enum: [this, following, all]
   *       - name: occurrenceDate
   *         in: query
   *         required: false
   *         description: Required with `this` and `following`.
   *         schema:
   *           type: string
   *           format: date
   *       - name: changes
   *         in: query
   *         required: false
   *         description: The PATCH body's `changes`, JSON-encoded. Defaults to no change.
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/GroupEventChanges'
   *     responses:
   *       '200':
   *         description: What the edit would drop
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [droppedOneOffs]
   *               properties:
   *                 droppedOneOffs:
   *                   type: integer
   *                   minimum: 0
   *       '401':
   *         description: Unauthorized
   *       '403':
   *         description: Not the creator while a member of the group, and not its admin
   *       '404':
   *         description: No such live group event
   *       '422':
   *         description: Invalid inputs, as the PATCH answers them
   *       '500':
   *         description: Internal Server Error
   */
  app.get("/:id/impact", tryCatch(handleGetGroupEventImpact));

  /**
   * @openapi
   * /api/group-events/{id}:
   *   patch:
   *     tags:
   *       - Group events
   *     summary: Edit a group event, one occurrence, the rest or all of it
   *     description: |
   *       The creator while still a member of the group, or a group admin
   *       (an org admin who is not a member included), edits in one
   *       transaction. A one-off takes its changes directly, `scope` ignored;
   *       giving it `repeat` makes it a recurring group event, which unlinks
   *       it from any recurring group event it replaced a day of. A recurring
   *       group event needs a `scope`:
   *
   *       - `this`: `occurrenceDate` must be a date the rule produces and has
   *         not skipped. The date joins `skippedDates` and a one-off, linked
   *         through `recurringEventId` and `originalDate`, takes the changes.
   *         The rule never changes; the one-off lasts one day.
   *       - `following`: splits at `occurrenceDate`. The event ends the day
   *         before through `repeat.until`, and a new recurring group event
   *         with the changes starts on that date, taking the skipped dates and
   *         linked one-offs from it on. With `repeat: null` the new row is a
   *         plain one-off on that date and the later one-off changes drop.
   *         From the first occurrence it is the same as `all`.
   *       - `all`: changes the recurring group event. A changed title, note or
   *         times overwrites them on its linked one-offs; skipped dates stay.
   *         A changed rule or start drops every one-off change, skipped dates
   *         included; a change of `repeat.until` alone drops only those past
   *         the new end. `repeat: null` keeps the first occurrence as a
   *         one-off.
   *
   *       `following` and `all` apply the same carry rule to the part they
   *       rewrite. Past occurrences have no lock. Only the new event of a
   *       `following` split and a one-off gaining `repeat` need a paid plan;
   *       every other edit works on a lapsed group.
   *     operationId: handlePatchGroupEvent
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
   *             properties:
   *               scope:
   *                 type: string
   *                 enum: [this, following, all]
   *                 description: Required for a recurring group event, ignored on a one-off.
   *               occurrenceDate:
   *                 type: string
   *                 format: date
   *                 description: The occurrence `this` and `following` start from. Ignored by `all`.
   *               changes:
   *                 $ref: '#/components/schemas/GroupEventChanges'
   *     responses:
   *       '200':
   *         description: The rows written and what was dropped
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/GroupEventWriteResult'
   *       '401':
   *         description: Unauthorized
   *       '402':
   *         description: |
   *           A `following` split, or a one-off gaining a repeat rule, on a
   *           group whose organization is not on a paid plan. `context` is
   *           `{ reason: "PLAN_LIMIT", code: "GROUP_EVENTS_PLAN_REQUIRED" }`.
   *       '403':
   *         description: Not the creator while a member of the group, and not its admin
   *       '404':
   *         description: No such live group event
   *       '422':
   *         description: |
   *           Invalid body; no `scope` on a recurring group event; no
   *           `occurrenceDate`, or one the rule does not produce, with `this`
   *           or `following`; a new rule or more than one day with `this`; or a
   *           result `POST /api/group-events` would refuse.
   *       '500':
   *         description: Internal Server Error
   *   delete:
   *     tags:
   *       - Group events
   *     summary: Delete a group event, one occurrence, the rest or all of it
   *     description: |
   *       Same rights as the PATCH; never gated on the plan. A delete is final:
   *       the row keeps only its id, group, dates and one-off link, with
   *       `deletedAt` set, so the sync pull and connected calendars can remove
   *       it. Nothing lists or restores it.
   *
   *       A one-off is deleted whatever the `scope`; one linked to a recurring
   *       group event leaves its original date skipped there. A recurring
   *       group event needs a `scope`: `this` skips `occurrenceDate`,
   *       `following` ends the event the day before `occurrenceDate` and
   *       deletes the linked one-offs from that date on (from the first
   *       occurrence it is `all`), `all` deletes the event and every linked
   *       one-off.
   *     operationId: handleDeleteGroupEvent
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *       - name: scope
   *         in: query
   *         required: false
   *         description: Required for a recurring group event, ignored on a one-off.
   *         schema:
   *           type: string
   *           enum: [this, following, all]
   *       - name: occurrenceDate
   *         in: query
   *         required: false
   *         description: Required with `this` and `following`; must be a date the rule produces and has not skipped.
   *         schema:
   *           type: string
   *           format: date
   *     responses:
   *       '200':
   *         description: The rows written; `droppedOneOffs` is 0
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/GroupEventWriteResult'
   *       '401':
   *         description: Unauthorized
   *       '403':
   *         description: Not the creator while a member of the group, and not its admin
   *       '404':
   *         description: No such live group event
   *       '422':
   *         description: |
   *           An id that is not a UUID, no `scope` on a recurring group event,
   *           or a missing or wrong `occurrenceDate`
   *       '500':
   *         description: Internal Server Error
   */
  app.patch(
    "/:id",
    bodyValidationMiddleware(validatePatchGroupEvent),
    tryCatch(handlePatchGroupEvent)
  );

  app.delete("/:id", tryCatch(handleDeleteGroupEvent));

  return app;
};

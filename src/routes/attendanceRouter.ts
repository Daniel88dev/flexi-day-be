import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import {
  validateAttendanceLocation,
  validateAttendanceScope,
} from "../services/attendance/types.js";
import { handleGetAttendanceState } from "../controllers/attendance/handleGetAttendanceState.js";
import { handleGetAttendanceMonth } from "../controllers/attendance/handleGetAttendanceMonth.js";
import { handleClockIn } from "../controllers/attendance/handleClockIn.js";
import { handleClockOut } from "../controllers/attendance/handleClockOut.js";
import { handleStartBreak } from "../controllers/attendance/handleStartBreak.js";
import { handleEndBreak } from "../controllers/attendance/handleEndBreak.js";
import { handleUpdateSessionLocation } from "../controllers/attendance/handleUpdateSessionLocation.js";

export const attendanceRouter = (): Router => {
  const app = Router();

  /**
   * @openapi
   * /api/attendance/current:
   *   get:
   *     tags:
   *       - Attendance
   *     summary: The caller's clock, right now
   *     description: |
   *       Everything the clock widget renders from: the open session and the
   *       open break if there are any, today's sessions with their breaks, and
   *       whether attendance is active and location switched on. `organizationId`
   *       is optional — omitting it resolves the caller's own Employment,
   *       preferring an organization where attendance is actually live over an
   *       older one where it is not.
   *
   *       Never gated by the plan. A lapsed organization answers `active: false`
   *       with its history intact, which is what the widget needs to explain
   *       why there is no button.
   *
   *       The open session is not necessarily one of `sessions`: one left
   *       running across midnight keeps the business date it started on, and
   *       neither is `autoClosedSession`, which reaches back a day and may be
   *       open.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: organizationId
   *         description: Defaults to the caller's own Employment.
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: |
   *           `{ organizationId, employmentId, employmentEnded, active,
   *           locationEnabled, timezone, businessDate, openSession, openBreak,
   *           sessions, autoClosedSession }`. `autoClosedSession` is the most
   *           recent session on this business date or the one before that the
   *           ceiling sweep touched, or null — what the widget asks to be
   *           corrected. Two cases, so read both markers: `closedBy: "SWEEP"`
   *           is the session itself, and a `breaks[]` entry with
   *           `autoClosed: true` is a break closed inside a session that may
   *           still be open and may read `closedBy: "USER"`.
   *           A session is `{ id, businessDate, startedAt, endedAt,
   *           timezone, closedBy, open, startLatitude, startLongitude,
   *           startAccuracy, endLatitude, endLongitude, endAccuracy, breaks }`,
   *           the six location fields null unless the organization records
   *           location and the browser's prompt was allowed; a break is
   *           `{ id, sessionId, startedAt, endedAt, autoClosed, open }`.
   *       '404':
   *         description: The caller holds no Employment in that organization
   *       '422':
   *         description: Malformed organizationId
   */
  app.get("/current", tryCatch(handleGetAttendanceState));

  /**
   * @openapi
   * /api/attendance/month:
   *   get:
   *     tags:
   *       - Attendance
   *     summary: One month of the caller's own attendance
   *     description: |
   *       Every business date of the month with the sessions that fall on it and
   *       the figures `docs/attendance.md` defines: presence, the break taken,
   *       what was deducted, worked time, required time and the balance. The
   *       rules travel with the answer — required minutes, the break allowance
   *       and its threshold, and the balance mode — because an employee can read
   *       them nowhere else.
   *
   *       A session belongs wholly to the business date it started on, so one
   *       that crossed midnight is on the earlier day and its whole length
   *       counts there.
   *
   *       Nothing is owed on an excluded date — a day of the week the
   *       organization does not keep, a public holiday of its country, a date
   *       outside this Employment's own spell, or an approved absence. A
   *       half-day absence halves the required time instead. Clocking in on one
   *       is allowed: the day counts and is flagged.
   *
   *       The caller's own Employment only. An admin reads somebody else's
   *       through the team dashboard, which carries the visibility matrix.
   *       Naming another `userId` is refused rather than ignored, so a caller
   *       is never shown their own month believing it is a colleague's.
   *
   *       Never gated by the plan: a lapsed organization's history stays
   *       readable.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: year
   *         required: true
   *         schema:
   *           type: integer
   *       - in: query
   *         name: month
   *         required: true
   *         description: 1 to 12.
   *         schema:
   *           type: integer
   *       - in: query
   *         name: organizationId
   *         description: Defaults to the caller's own Employment.
   *         schema:
   *           type: string
   *       - in: query
   *         name: userId
   *         description: The caller's own, or the request is refused.
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: |
   *           `{ organizationId, employmentId, timezone, businessDate, year,
   *           month, balanceMode, requiredMinutesPerDay, requiredMinutesOverride,
   *           breakMinutes, breakThresholdMinutes, days, totals }`.
   *           `requiredMinutesPerDay` is what the days were measured against —
   *           the Employment's override where there is one, which
   *           `requiredMinutesOverride` repeats and is otherwise null.
   *           A day is `{ businessDate, presenceMinutes, breaksMinutes,
   *           deductedMinutes, workedMinutes, requiredMinutes, balanceMinutes,
   *           upcoming, open, autoClosed, exclusion, excludedClockIn, flagged,
   *           sessions }`.
   *           `balanceMinutes` is null on an upcoming date, throughout
   *           `MONTHLY` mode, where the month carries the only balance, and on
   *           an excluded day nobody worked.
   *           `exclusion` is null on an ordinary working day and otherwise
   *           `{ cause, extent, label }`: `cause` is `NOT_EMPLOYED`,
   *           `NON_WORKING_DAY`, `HOLIDAY` or `ABSENCE`, `extent` is `FULL` or
   *           `HALF`, and `label` is the holiday's name or the absence's record
   *           type where there is one to give.
   *           `totals` is `{ presenceMinutes, workedMinutes, requiredMinutes,
   *           requiredRangeMinutes, balanceMinutes, flaggedDays, excludedDays }`,
   *           where `requiredMinutes` counts only the dates already begun — what
   *           the balance is measured against — and `requiredRangeMinutes` the
   *           whole month. `excludedDays` counts the days off in the month,
   *           upcoming ones included and `NOT_EMPLOYED` ones not.
   *       '403':
   *         description: |
   *           The query named somebody else. `context.reason` is
   *           `OWN_EMPLOYMENT_ONLY`.
   *       '404':
   *         description: The caller holds no Employment in that organization
   *       '422':
   *         description: Missing or malformed year, month or organizationId
   */
  app.get("/month", tryCatch(handleGetAttendanceMonth));

  /**
   * @openapi
   * /api/attendance/clock-in:
   *   post:
   *     tags:
   *       - Attendance
   *     summary: Start a session
   *     description: |
   *       Opens a session at the server's instant — the client never supplies
   *       one. The business date is computed from that instant in the
   *       organization's timezone and stored with the zone, so a session that
   *       crosses midnight belongs wholly to the day it started and no later
   *       change of the organization's zone moves it.
   *
   *       One event row is appended in the same transaction as the session.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               organizationId:
   *                 type: string
   *                 description: Defaults to the caller's own Employment.
   *     responses:
   *       '201':
   *         description: The open session
   *       '402':
   *         description: |
   *           Attendance is not active for this organization — switched off, or
   *           the plan lapsed. `context.reason` is `PLAN_LIMIT`.
   *       '403':
   *         description: |
   *           The caller's Employment has ended. `context.reason` is
   *           `EMPLOYMENT_ENDED`.
   *       '404':
   *         description: The caller holds no Employment in that organization
   *       '409':
   *         description: |
   *           A session is already open. `context` carries
   *           `{ reason: "SESSION_ALREADY_OPEN", sessionId, startedAt }`, so the
   *           widget can offer clocking out instead.
   */
  app.post("/clock-in", bodyValidationMiddleware(validateAttendanceScope), tryCatch(handleClockIn));

  /**
   * @openapi
   * /api/attendance/clock-out:
   *   post:
   *     tags:
   *       - Attendance
   *     summary: End the open session
   *     description: |
   *       Closes the session at the server's instant and marks it closed by the
   *       user. A break still running is closed at the same instant, so the time
   *       is counted rather than left open, and that close is recorded on the
   *       clock-out's own event rather than getting one of its own. It is not
   *       flagged auto-closed: that flag belongs to the ceiling sweep and the
   *       corrections it asks for.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               organizationId:
   *                 type: string
   *     responses:
   *       '200':
   *         description: The closed session, with its breaks
   *       '402':
   *         description: Attendance is not active. `context.reason` is `PLAN_LIMIT`.
   *       '403':
   *         description: The caller's Employment has ended (`EMPLOYMENT_ENDED`)
   *       '404':
   *         description: The caller holds no Employment in that organization
   *       '409':
   *         description: |
   *           Nothing is open. `context.reason` is `NO_OPEN_SESSION`.
   */
  app.post(
    "/clock-out",
    bodyValidationMiddleware(validateAttendanceScope),
    tryCatch(handleClockOut)
  );

  /**
   * @openapi
   * /api/attendance/break/start:
   *   post:
   *     tags:
   *       - Attendance
   *     summary: Start a break
   *     description: |
   *       A break exists only inside an open session. One at a time, held by a
   *       partial unique index rather than by the read that precedes it.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               organizationId:
   *                 type: string
   *     responses:
   *       '201':
   *         description: The open break
   *       '402':
   *         description: Attendance is not active. `context.reason` is `PLAN_LIMIT`.
   *       '403':
   *         description: The caller's Employment has ended (`EMPLOYMENT_ENDED`)
   *       '404':
   *         description: The caller holds no Employment in that organization
   *       '409':
   *         description: |
   *           `context.reason` is `NO_OPEN_SESSION` when nothing is clocked in,
   *           or `BREAK_ALREADY_OPEN` with `{ breakId, startedAt }` when one is
   *           already running.
   */
  app.post(
    "/break/start",
    bodyValidationMiddleware(validateAttendanceScope),
    tryCatch(handleStartBreak)
  );

  /**
   * @openapi
   * /api/attendance/break/end:
   *   post:
   *     tags:
   *       - Attendance
   *     summary: End the open break
   *     description: Puts the open session back to working time at the server's instant.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               organizationId:
   *                 type: string
   *     responses:
   *       '200':
   *         description: The closed break
   *       '402':
   *         description: Attendance is not active. `context.reason` is `PLAN_LIMIT`.
   *       '403':
   *         description: The caller's Employment has ended (`EMPLOYMENT_ENDED`)
   *       '404':
   *         description: The caller holds no Employment in that organization
   *       '409':
   *         description: |
   *           `context.reason` is `NO_OPEN_SESSION` when nothing is clocked in,
   *           or `NO_OPEN_BREAK` when no break is running.
   */
  app.post(
    "/break/end",
    bodyValidationMiddleware(validateAttendanceScope),
    tryCatch(handleEndBreak)
  );

  /**
   * @openapi
   * /api/attendance/sessions/{sessionId}/location:
   *   post:
   *     tags:
   *       - Attendance
   *     summary: Attach a location fix to one end of a session
   *     description: |
   *       Where the clock was pressed, as the browser's own permission prompt
   *       reported it a moment after the click. Never asked for in the
   *       background and never required: a person who declines leaves the
   *       columns null, which is indistinguishable from never having been
   *       asked.
   *
   *       A fix is written only when it arrives within two minutes of the
   *       instant it names and beats the accuracy already stored — `accuracy`
   *       is the browser's radius in metres, so smaller wins. The client sends
   *       two per clock, a fast coarse one and a slower precise one, so most
   *       calls legitimately change nothing.
   *
   *       Everything short of an outright refusal answers 200 with
   *       `applied: false` and the coordinates as they stand: the window has
   *       passed, the fix is no better, the organization never switched
   *       location on, or `OUT` was named on a session still open. Only
   *       somebody else's session and a malformed fix are errors.
   *
   *       Appends one `LOCATION_UPDATED` event, and only when something
   *       actually changed.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [end, latitude, longitude, accuracy]
   *             properties:
   *               end:
   *                 type: string
   *                 enum: [IN, OUT]
   *                 description: Which clock the fix belongs to.
   *               latitude:
   *                 type: number
   *                 minimum: -90
   *                 maximum: 90
   *               longitude:
   *                 type: number
   *                 minimum: -180
   *                 maximum: 180
   *               accuracy:
   *                 type: number
   *                 exclusiveMinimum: 0
   *                 description: The browser's radius in metres; smaller is better.
   *     responses:
   *       '200':
   *         description: |
   *           `{ applied, end, latitude, longitude, accuracy }` — the
   *           coordinates as they now stand for that end, whether or not this
   *           call is what put them there.
   *       '403':
   *         description: |
   *           The session belongs to another user. `context.reason` is
   *           `NOT_YOUR_SESSION`.
   *       '404':
   *         description: No such session
   *       '422':
   *         description: Malformed fix
   */
  app.post(
    "/sessions/:sessionId/location",
    bodyValidationMiddleware(validateAttendanceLocation),
    tryCatch(handleUpdateSessionLocation)
  );

  return app;
};

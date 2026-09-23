import { Router } from "express";
import { tryCatch } from "../middleware/tryCatch.js";
import { bodyValidationMiddleware } from "../middleware/validationMiddleware.js";
import {
  validateAttendanceCorrection,
  validateAttendanceEntry,
  validateAttendanceLocation,
  validateAttendanceScope,
} from "../services/attendance/types.js";
import { handleGetAttendanceState } from "../controllers/attendance/handleGetAttendanceState.js";
import { handleGetAttendanceMonth } from "../controllers/attendance/handleGetAttendanceMonth.js";
import { handleGetTeamAttendance } from "../controllers/attendance/handleGetTeamAttendance.js";
import { handleGetAttendanceDay } from "../controllers/attendance/handleGetAttendanceDay.js";
import { handleClockIn } from "../controllers/attendance/handleClockIn.js";
import { handleClockOut } from "../controllers/attendance/handleClockOut.js";
import { handleStartBreak } from "../controllers/attendance/handleStartBreak.js";
import { handleEndBreak } from "../controllers/attendance/handleEndBreak.js";
import { handleUpdateSessionLocation } from "../controllers/attendance/handleUpdateSessionLocation.js";
import { handlePatchAttendanceSession } from "../controllers/attendance/handlePatchAttendanceSession.js";
import { handleDeleteAttendanceSession } from "../controllers/attendance/handleDeleteAttendanceSession.js";
import { handlePatchAttendanceBreak } from "../controllers/attendance/handlePatchAttendanceBreak.js";
import { handleDeleteAttendanceBreak } from "../controllers/attendance/handleDeleteAttendanceBreak.js";
import { handleGetAttendanceSessionEvents } from "../controllers/attendance/handleGetAttendanceSessionEvents.js";
import { handleEnterAttendanceSession } from "../controllers/attendance/handleEnterAttendanceSession.js";

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
   *           locationEnabled, selfService, timezone, businessDate, openSession,
   *           openBreak, sessions, autoClosedSession }`. `selfService` is the
   *           organization's self-service window, `{ enabled, days }`: `days`
   *           is how many days before today the employee may still correct
   *           their own attendance, null for no limit, and means nothing
   *           while `enabled` is false. `autoClosedSession` is the most
   *           recent session on this business date or the one before that the
   *           ceiling sweep touched, or null — what the widget asks to be
   *           corrected. Two cases, so read both markers: `closedBy: "SWEEP"`
   *           is the session itself, and a `breaks[]` entry with
   *           `autoClosed: true` is a break closed inside a session that may
   *           still be open and may read `closedBy: "USER"`.
   *           A session is `{ id, businessDate, startedAt, endedAt,
   *           timezone, closedBy, origin, enteredByUserId, open, startLatitude,
   *           startLongitude, startAccuracy, endLatitude, endLongitude,
   *           endAccuracy, breaks }`, `origin` being `CLOCKED` or `ENTERED`
   *           (recorded after the fact through `POST /api/attendance/sessions`,
   *           for good), `enteredByUserId` the user who entered it and null for
   *           a clocked session, and the six
   *           location fields null unless the organization records
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
   *           upcoming, open, autoClosed, exclusion, excludedClockIn, entered,
   *           flagged, sessions }`, a session shaped as on
   *           `/api/attendance/current`. `entered` is true when a session on
   *           the date was entered after the fact; it is a fact about the day,
   *           not a flag, and never counts toward `flagged`.
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
   * /api/attendance/day:
   *   get:
   *     tags:
   *       - Attendance
   *     summary: One person's business date
   *     description: |
   *       The sessions of one Employment on one business date, with their
   *       breaks — what the correction dialog opens onto, from either screen.
   *
   *       Scoped by the visibility table in `docs/attendance.md`: the person
   *       themselves, the group admins of any group they belong to, and the
   *       organization's admins. Naming somebody else is the normal case here,
   *       unlike `/api/attendance/month`, which answers for its caller alone.
   *
   *       Soft-deleted sessions are gone from it. Never gated by the plan.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: businessDate
   *         required: true
   *         description: The organization's local day, as `YYYY-MM-DD`.
   *         schema:
   *           type: string
   *           format: date
   *       - in: query
   *         name: userId
   *         description: Defaults to the caller.
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: |
   *           `{ organizationId, employmentId, userId, businessDate, timezone,
   *           sessions }`, a session shaped as on `/api/attendance/current`,
   *           `origin` included.
   *       '403':
   *         description: No permission for that Employment
   *       '404':
   *         description: That person holds no Employment in that organization
   *       '422':
   *         description: Missing or malformed organizationId or businessDate
   */
  app.get("/day", tryCatch(handleGetAttendanceDay));

  /**
   * @openapi
   * /api/attendance/team:
   *   get:
   *     tags:
   *       - Attendance
   *     summary: The team dashboard
   *     description: |
   *       Every Employment the caller may see, each with its days over the
   *       range and the range's totals, and who is clocked in right now. The
   *       scope is the visibility table's in `docs/attendance.md`: an
   *       organization admin sees every active Employment, a group admin the
   *       union of their groups' current members, and anyone else is refused.
   *       A manager holds no membership row, so their own Employment — and
   *       anyone else's in no group — appears only for organization admins.
   *
   *       `groupId` narrows the answer to that group's current members. An
   *       organization admin may name any live group of the organization; a
   *       group admin only one they administer.
   *
   *       Each day carries the same figures and flags as `/api/attendance/month`,
   *       worked out by the same computation, minus the sessions themselves.
   *       `inNow` lists the open sessions regardless of business date, so
   *       somebody still clocked in from an earlier day is in it.
   *
   *       Never gated by the plan: a lapsed organization's history stays
   *       readable.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: organizationId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: from
   *         required: true
   *         description: First business date, `YYYY-MM-DD`.
   *         schema:
   *           type: string
   *           format: date
   *       - in: query
   *         name: to
   *         required: true
   *         description: Last business date, inclusive. The range may contain at most 93 dates.
   *         schema:
   *           type: string
   *           format: date
   *       - in: query
   *         name: groupId
   *         description: Narrow to one group's current members.
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: |
   *           `{ organizationId, timezone, businessDate, from, to, balanceMode,
   *           requiredMinutesPerDay, breakMinutes, breakThresholdMinutes,
   *           selfService, scope, group, people, inNow }`. `selfService` is
   *           the organization's self-service window, `{ enabled, days }`, as
   *           on `/api/attendance/current`, so a group admin can read what
   *           their members may do.
   *           `scope` is `ORGANIZATION` when the caller sees the whole
   *           organization and `GROUPS` when they see only their groups'
   *           members, whether or not a group was named. `group` is
   *           `{ id, groupName }` when the answer was narrowed, otherwise null.
   *           A person is `{ employmentId, userId, user, groups,
   *           requiredMinutesPerDay, requiredMinutesOverride, days, totals }`,
   *           sorted by name; `groups` is `[{ id, groupName }]` of the live
   *           groups they belong to. Each day and the totals read exactly as
   *           on `/api/attendance/month`, without `sessions` — `entered` still
   *           says whether a session on the date was entered after the fact.
   *           An entry of `inNow` is `{ employmentId, userId, sessionId,
   *           businessDate, startedAt, onBreak, breakStartedAt }`.
   *       '403':
   *         description: |
   *           The caller administers nothing in the organization, or named a
   *           group they do not administer.
   *       '404':
   *         description: No live group with that id in that organization
   *       '422':
   *         description: |
   *           Missing or malformed organizationId, from or to; `to` before
   *           `from`; or a range longer than 93 days.
   */
  app.get("/team", tryCatch(handleGetTeamAttendance));

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

  /**
   * @openapi
   * /api/attendance/sessions:
   *   post:
   *     tags:
   *       - Attendance
   *     summary: Enter a session after the fact
   *     description: |
   *       Records a session nobody clocked: a business date and both ends,
   *       closed and wholly in the past. It is marked `origin: "ENTERED"` for
   *       good, whoever entered it (`docs/attendance.md`, "Entered sessions").
   *
   *       Who may: a group admin of any group that person belongs to and the
   *       organization's admins, for any day; the person themselves only inside
   *       the organization's self-service window, and never once their
   *       Employment has ended. `userId` defaults to the caller.
   *
   *       The start has to fall on `businessDate` in the organization's
   *       timezone; the end may cross midnight, and the session stays on the
   *       day it started. The end comes after the start and not after now, the
   *       span is no longer than the organization's session ceiling, the date
   *       lies inside the Employment's spell, and the span may not run across
   *       another of that person's live sessions, an open one included. An
   *       excluded day is allowed and flagged like a clock-in on one. No
   *       location is taken.
   *
   *       Takes the same Employment lock a clock-in takes, so an entry racing
   *       a clock-in cannot leave two sessions over the same minutes. Refused
   *       like a correction while attendance is not active.
   *
   *       One `SESSION_CREATED` event is appended in the same transaction, with
   *       the caller as its user and the session as saved as `after`:
   *       `{ businessDate, startedAt, endedAt, timezone, closedBy, origin }`.
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - organizationId
   *               - businessDate
   *               - startedAt
   *               - endedAt
   *             properties:
   *               organizationId:
   *                 type: string
   *               userId:
   *                 type: string
   *                 description: Whose session it is. Defaults to the caller.
   *               businessDate:
   *                 type: string
   *                 format: date
   *                 description: The organization's local day the session belongs to, as `YYYY-MM-DD`.
   *               startedAt:
   *                 type: string
   *                 format: date-time
   *                 description: With an offset. Has to fall on `businessDate` in the organization's zone.
   *               endedAt:
   *                 type: string
   *                 format: date-time
   *                 description: With an offset. After `startedAt`, not after now.
   *     responses:
   *       '201':
   *         description: |
   *           The entered session, shaped as on `/api/attendance/current`, with
   *           `origin: "ENTERED"`, `enteredByUserId` the caller, `closedBy`
   *           `ADMIN` or `USER` by who entered it, and no breaks.
   *       '402':
   *         description: Attendance is not active. `context.reason` is `PLAN_LIMIT`.
   *       '403':
   *         description: |
   *           No standing over this Employment, or the employee may not enter
   *           it themselves. `context.reason` says why: `SELF_SERVICE_OFF` when
   *           the organization has self-service off, `SELF_SERVICE_WINDOW` when
   *           the business date is outside the window, and `EMPLOYMENT_ENDED`
   *           when their Employment has ended.
   *       '404':
   *         description: That person holds no Employment in that organization
   *       '409':
   *         description: |
   *           `SESSION_OVERLAPS`: another of that person's sessions already
   *           covers part of the span. `context` carries the other session's
   *           `{ sessionId, startedAt, endedAt }`.
   *       '422':
   *         description: |
   *           A missing or malformed field, or `context.reason` naming the rule:
   *           `START_OFF_DATE` when the start is not on `businessDate` in the
   *           organization's zone, `OUTSIDE_EMPLOYMENT` when the date is outside
   *           the Employment's spell, `END_BEFORE_START`, `END_IN_FUTURE`, or
   *           `OVER_CEILING` with `context.ceilingMinutes` when the span is
   *           longer than the session ceiling.
   */
  app.post(
    "/sessions",
    bodyValidationMiddleware(validateAttendanceEntry),
    tryCatch(handleEnterAttendanceSession)
  );

  /**
   * @openapi
   * /api/attendance/sessions/{sessionId}:
   *   patch:
   *     tags:
   *       - Attendance
   *     summary: Correct a session's clock-in or clock-out
   *     description: |
   *       Moves one end of a session or both. Who may: a group admin of any
   *       group that person belongs to and the organization's admins, always;
   *       the session's own user only inside the organization's self-service
   *       window — off, today and N days back, or no limit, with a session
   *       still open passing whatever its date while the window is on — and
   *       never once their Employment has ended (`docs/attendance.md`). A
   *       refused employee is told to ask an admin rather than simply refused.
   *
   *       Only the keys present are changed. `endedAt: null` reopens a closed
   *       session, which an absent `endedAt` never does.
   *
   *       The business date does not move with the times: it is fixed at
   *       clock-in and never recomputed, so a correction changes what a day
   *       holds rather than which day holds it.
   *
   *       Correcting an end records who closed the session, so a session the
   *       sweep closed stops being flagged once somebody has overruled it.
   *
   *       One `SESSION_EDITED` event is appended in the same transaction,
   *       carrying the times and `closedBy` as they stood before and after.
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
   *             properties:
   *               startedAt:
   *                 type: string
   *                 format: date-time
   *               endedAt:
   *                 type: string
   *                 format: date-time
   *                 nullable: true
   *                 description: Null reopens the session.
   *     responses:
   *       '200':
   *         description: The session as it now stands, with its breaks
   *       '402':
   *         description: Attendance is not active. `context.reason` is `PLAN_LIMIT`.
   *       '403':
   *         description: |
   *           No standing over this Employment, or the employee may not change
   *           it themselves. `context.reason` says why: `SELF_SERVICE_OFF` when
   *           the organization has self-service off, `SELF_SERVICE_WINDOW` when
   *           the session's business date is outside the window, and
   *           `EMPLOYMENT_ENDED` when their Employment has ended.
   *       '404':
   *         description: No such session, or it has been deleted
   *       '409':
   *         description: |
   *           `SESSION_ALREADY_OPEN` when reopening this one would leave two
   *           open at once, or `SESSION_OVERLAPS` when the corrected times would
   *           run across another of that person's sessions — two spans over the
   *           same minutes would be counted twice. `context` carries the other
   *           session's `{ sessionId, startedAt }` either way.
   *       '422':
   *         description: |
   *           A patch that changes nothing, a malformed instant, an end at or
   *           before its start (`END_BEFORE_START`), or times that would leave a
   *           break outside its session (`BREAK_OUTSIDE_SESSION`).
   */
  app.patch(
    "/sessions/:sessionId",
    bodyValidationMiddleware(validateAttendanceCorrection),
    tryCatch(handlePatchAttendanceSession)
  );

  /**
   * @openapi
   * /api/attendance/sessions/{sessionId}:
   *   delete:
   *     tags:
   *       - Attendance
   *     summary: Soft-delete a session
   *     description: |
   *       For a session clocked by mistake. The row stays with `deletedAt` set
   *       and disappears from every read; its breaks and its whole timeline stay
   *       with it, and one `SESSION_DELETED` event is appended.
   *
   *       Deleting an open session frees the clock — the index behind "one open
   *       session per Employment" excludes deleted rows.
   *
   *       Authorized as the patch is, self-service window included, with one
   *       rule more: the employee may delete a session they entered
   *       themselves (`enteredByUserId` is theirs), or a clocked session dated
   *       today. A clocked session from an earlier day, or one an admin
   *       entered for them, can be corrected, not removed.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The session that was deleted, as it stood
   *       '402':
   *         description: Attendance is not active. `context.reason` is `PLAN_LIMIT`.
   *       '403':
   *         description: |
   *           No standing over this Employment, or the employee may not change
   *           it themselves. `context.reason` says why: `SELF_SERVICE_OFF` when
   *           the organization has self-service off, `SELF_SERVICE_WINDOW` when
   *           the session's business date is outside the window, and
   *           `EMPLOYMENT_ENDED` when their Employment has ended,
   *           `SELF_SERVICE_DELETE` when they try to delete a clocked session
   *           from an earlier day, and `SELF_SERVICE_DELETE_ENTERED` when they
   *           try to delete one an admin entered for them on an earlier day.
   *       '404':
   *         description: No such session, or it was already deleted
   */
  app.delete("/sessions/:sessionId", tryCatch(handleDeleteAttendanceSession));

  /**
   * @openapi
   * /api/attendance/breaks/{breakId}:
   *   patch:
   *     tags:
   *       - Attendance
   *     summary: Correct a break's times
   *     description: |
   *       Moves one end of a break or both, under the same authorization as the
   *       session it belongs to. A break has to stay inside its session and end
   *       after it starts; `endedAt: null` reopens it, and is refused when
   *       another break on the session is already open.
   *
   *       Correcting the end clears `autoClosed`: the flag is the sweep's claim
   *       that nobody has checked the number, and somebody just has.
   *
   *       Answers with the whole session, because the day's figures moved with
   *       the break. One `BREAK_EDITED` event is appended.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: breakId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               startedAt:
   *                 type: string
   *                 format: date-time
   *               endedAt:
   *                 type: string
   *                 format: date-time
   *                 nullable: true
   *                 description: Null reopens the break.
   *     responses:
   *       '200':
   *         description: The session the break belongs to, as it now stands
   *       '402':
   *         description: Attendance is not active. `context.reason` is `PLAN_LIMIT`.
   *       '403':
   *         description: |
   *           No standing over this Employment, or the employee may not change
   *           it themselves. `context.reason` says why: `SELF_SERVICE_OFF` when
   *           the organization has self-service off, `SELF_SERVICE_WINDOW` when
   *           the session's business date is outside the window, and
   *           `EMPLOYMENT_ENDED` when their Employment has ended.
   *       '404':
   *         description: No such break, or its session has been deleted
   *       '409':
   *         description: |
   *           Reopening it would leave two breaks open on the session.
   *           `context` carries `{ reason: "BREAK_ALREADY_OPEN", breakId, startedAt }`.
   *       '422':
   *         description: |
   *           A patch that changes nothing, a malformed instant,
   *           `END_BEFORE_START`, or `BREAK_OUTSIDE_SESSION`.
   */
  app.patch(
    "/breaks/:breakId",
    bodyValidationMiddleware(validateAttendanceCorrection),
    tryCatch(handlePatchAttendanceBreak)
  );

  /**
   * @openapi
   * /api/attendance/breaks/{breakId}:
   *   delete:
   *     tags:
   *       - Attendance
   *     summary: Remove a break
   *     description: |
   *       Deletes the break row outright, under the same authorization as its
   *       session. One `BREAK_DELETED` event carries what it was, which is all
   *       that is left of it.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: breakId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: The session the break belonged to, as it now stands
   *       '402':
   *         description: Attendance is not active. `context.reason` is `PLAN_LIMIT`.
   *       '403':
   *         description: |
   *           No standing over this Employment, or the employee may not change
   *           it themselves. `context.reason` says why: `SELF_SERVICE_OFF` when
   *           the organization has self-service off, `SELF_SERVICE_WINDOW` when
   *           the session's business date is outside the window, and
   *           `EMPLOYMENT_ENDED` when their Employment has ended.
   *       '404':
   *         description: No such break, or its session has been deleted
   */
  app.delete("/breaks/:breakId", tryCatch(handleDeleteAttendanceBreak));

  /**
   * @openapi
   * /api/attendance/sessions/{sessionId}/events:
   *   get:
   *     tags:
   *       - Attendance
   *     summary: A session's timeline
   *     description: |
   *       Every change to the session, oldest first, with the person behind it.
   *       A null `user` is the ceiling sweep, or an account that has since been
   *       deleted.
   *
   *       Read rights rather than correction rights: an employee reads their own
   *       history however old it is, and only changing it needs the window. A
   *       soft-deleted session still answers, its last entry being the delete.
   *
   *       `before` and `after` carry only the fields the change touched, so
   *       their shape follows `eventType`. Coordinates in a `LOCATION_UPDATED`
   *       payload are stripped by the retention sweep at twelve months, like the
   *       session's own.
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: |
   *           `{ sessionId, events }`, an event being
   *           `{ id, sessionId, eventType, user, before, after, createdAt }`.
   *           `eventType` is one of `CLOCK_IN`, `CLOCK_OUT`, `BREAK_START`,
   *           `BREAK_END`, `LOCATION_UPDATED`, `SESSION_EDITED`, `BREAK_EDITED`,
   *           `BREAK_DELETED`, `SESSION_DELETED` or `SESSION_CREATED`. An
   *           entered session's timeline opens with `SESSION_CREATED`, whose
   *           `user` entered it and whose `after` is
   *           `{ businessDate, startedAt, endedAt, timezone, closedBy, origin }`.
   *       '403':
   *         description: No permission for this Employment
   *       '404':
   *         description: No such session
   */
  app.get("/sessions/:sessionId/events", tryCatch(handleGetAttendanceSessionEvents));

  return app;
};

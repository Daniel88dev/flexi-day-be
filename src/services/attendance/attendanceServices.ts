import { and, asc, desc, eq, exists, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import {
  attendanceBreaks,
  attendanceClosedBy,
  attendanceEventType,
  attendanceEvents,
  attendanceSessions,
} from "../../db/schema/attendance-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import AppError from "../../utils/appError.js";
import {
  businessDateInZone,
  expandDateRangeInclusive,
  monthEnd,
  monthStart,
  previousDay,
  type DateString,
} from "../../utils/dateFunc.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { assertAttendanceActive, isAttendanceActive } from "../billing/guards.js";
import { getEmployment, listEmploymentsForUser } from "../employment/employmentServices.js";
import { getAttendanceSettings } from "../organization/attendanceSettingsServices.js";
import { ATTENDANCE_SETTINGS_DEFAULTS } from "../../db/schema/organization-attendance-settings-schema.js";
import { computeAttendance } from "./attendanceCalculation.js";
import type { AttendanceSettingsType } from "../organization/types.js";
import type { EmploymentType } from "../employment/types.js";
import type {
  AttendanceBreakType,
  AttendanceSessionType,
  AttendanceSessionView,
  AttendanceStateType,
  AttendanceMonthType,
} from "./types.js";

/**
 * The Employment a request is about, with the rules that govern it. Settings
 * are undefined for an organization that never set attendance up.
 */
export type AttendanceSubject = {
  employment: EmploymentType;
  organizationId: string;
  settings: AttendanceSettingsType | undefined;
};

const SESSION_COLUMNS = {
  id: attendanceSessions.id,
  employmentId: attendanceSessions.employmentId,
  businessDate: attendanceSessions.businessDate,
  startedAt: attendanceSessions.startedAt,
  endedAt: attendanceSessions.endedAt,
  timezone: attendanceSessions.timezone,
  closedBy: attendanceSessions.closedBy,
  startLatitude: attendanceSessions.startLatitude,
  startLongitude: attendanceSessions.startLongitude,
  startAccuracy: attendanceSessions.startAccuracy,
  endLatitude: attendanceSessions.endLatitude,
  endLongitude: attendanceSessions.endLongitude,
  endAccuracy: attendanceSessions.endAccuracy,
};

const BREAK_COLUMNS = {
  id: attendanceBreaks.id,
  sessionId: attendanceBreaks.sessionId,
  startedAt: attendanceBreaks.startedAt,
  endedAt: attendanceBreaks.endedAt,
  autoClosed: attendanceBreaks.autoClosed,
};

const conflict = (
  reason: string,
  message: string,
  publicContext?: { [key: string]: unknown },
  context?: { [key: string]: unknown }
) =>
  new AppError({
    message,
    logging: true,
    code: 409,
    context,
    publicContext: { reason, ...publicContext },
  });

/**
 * Resolves which Employment the caller is clocking against. Naming the
 * organization is the normal case; omitting it is the widget's first load,
 * which has nothing to name yet. An organization where attendance is actually
 * live wins over an older Employment somewhere it is not, so a person whose
 * first organization never switched attendance on still lands on the one that
 * did. Ended Employments stay in the list — refusing one has to read as
 * "you no longer work here", not as "no such organization".
 */
export const resolveAttendanceSubject = async (
  userId: string,
  organizationId: string | undefined,
  tx?: DbTransaction
): Promise<AttendanceSubject | undefined> => {
  if (organizationId) {
    const employment = await getEmployment(organizationId, userId, tx);
    if (!employment) return undefined;
    return {
      employment,
      organizationId,
      settings: await getAttendanceSettings(organizationId, tx),
    };
  }

  const all = await listEmploymentsForUser(userId, tx);
  if (all.length === 0) return undefined;

  const candidates = all.filter((employment) => employment.endedAt === null);
  const ordered = candidates.length > 0 ? candidates : all;

  let fallback: AttendanceSubject | undefined;
  for (const employment of ordered) {
    const subject: AttendanceSubject = {
      employment,
      organizationId: employment.organizationId,
      settings: await getAttendanceSettings(employment.organizationId, tx),
    };
    fallback ??= subject;
    if (await isAttendanceActive(employment.organizationId, tx)) return subject;
  }

  return fallback;
};

/** {@link resolveAttendanceSubject}, 404 when the caller has no Employment to clock against. */
const requireSubject = async (
  userId: string,
  organizationId: string | undefined,
  tx?: DbTransaction
): Promise<AttendanceSubject> => {
  const subject = await resolveAttendanceSubject(userId, organizationId, tx);
  if (!subject) {
    throw new AppError({
      message: "No employment in this organization",
      logging: true,
      code: 404,
      context: { userId, organizationId },
    });
  }
  return subject;
};

/**
 * What every attendance write does before it touches a row: the plan gate, the
 * roster, and the zone the business date will be fixed in. Runs inside the
 * caller's transaction, so a 402 rolls the whole request back rather than
 * leaving half of it.
 */
export const beginAttendanceWrite = async (
  userId: string,
  organizationId: string | undefined,
  tx: DbTransaction
): Promise<AttendanceSubject & { timezone: string }> => {
  const subject = await requireSubject(userId, organizationId, tx);

  await assertAttendanceActive(subject.organizationId, tx);

  if (subject.employment.endedAt !== null) {
    throw new AppError({
      message: "This employment has ended",
      logging: true,
      code: 403,
      context: { userId, organizationId: subject.organizationId },
      publicContext: { reason: "EMPLOYMENT_ENDED" },
    });
  }

  // Attendance cannot be switched on without a zone, so this is unreachable
  // short of a hand-edited row — and guessing one would pick a day boundary
  // nobody chose.
  if (!subject.settings?.timezone) {
    throw new AppError({
      message: "This organization has no attendance timezone",
      logging: true,
      code: 500,
      context: { organizationId: subject.organizationId },
    });
  }

  return { ...subject, timezone: subject.settings.timezone };
};

/**
 * Serialises the Employment's clock for the rest of the transaction. The
 * open-session read below is a plain select, so without this two parallel
 * clock-ins both see nothing open and one dies on the unique index with a
 * message that cannot say when the other one started.
 *
 * The ceiling sweep takes the same lock: it is the one thing that writes to a
 * clock without a person behind it, and it must queue with them rather than
 * race them.
 */
export const lockEmployment = async (employmentId: string, tx: DbTransaction): Promise<void> => {
  const [row] = await tx
    .select({ id: employments.id })
    .from(employments)
    .where(eq(employments.id, employmentId))
    .for("update");

  if (!row) {
    throw new AppError({
      message: "Employment not found",
      logging: true,
      code: 500,
      context: { employmentId },
    });
  }
};

export const getOpenSession = async (
  employmentId: string,
  tx?: DbTransaction
): Promise<AttendanceSessionType | undefined> => {
  const [row] = await (tx ?? db)
    .select(SESSION_COLUMNS)
    .from(attendanceSessions)
    .where(
      and(
        eq(attendanceSessions.employmentId, employmentId),
        isNull(attendanceSessions.endedAt),
        isNull(attendanceSessions.deletedAt)
      )
    )
    .limit(1);

  return row;
};

export const getOpenBreak = async (
  sessionId: string,
  tx?: DbTransaction
): Promise<AttendanceBreakType | undefined> => {
  const [row] = await (tx ?? db)
    .select(BREAK_COLUMNS)
    .from(attendanceBreaks)
    .where(and(eq(attendanceBreaks.sessionId, sessionId), isNull(attendanceBreaks.endedAt)))
    .limit(1);

  return row;
};

const listBreaksForSessions = async (
  sessionIds: string[],
  tx?: DbTransaction
): Promise<AttendanceBreakType[]> => {
  if (sessionIds.length === 0) return [];

  return (tx ?? db)
    .select(BREAK_COLUMNS)
    .from(attendanceBreaks)
    .where(inArray(attendanceBreaks.sessionId, sessionIds))
    .orderBy(asc(attendanceBreaks.startedAt));
};

const withBreaks = async (
  sessions: AttendanceSessionType[],
  tx?: DbTransaction
): Promise<AttendanceSessionView[]> => {
  const breaks = await listBreaksForSessions(
    sessions.map((session) => session.id),
    tx
  );

  return sessions.map((session) => ({
    ...session,
    breaks: breaks.filter((entry) => entry.sessionId === session.id),
  }));
};

/** One business date's sessions, oldest first. Soft-deleted ones are gone for good. */
export const listSessionsForDate = async (
  employmentId: string,
  businessDate: DateString,
  tx?: DbTransaction
): Promise<AttendanceSessionView[]> => {
  const rows = await (tx ?? db)
    .select(SESSION_COLUMNS)
    .from(attendanceSessions)
    .where(
      and(
        eq(attendanceSessions.employmentId, employmentId),
        eq(attendanceSessions.businessDate, businessDate),
        isNull(attendanceSessions.deletedAt)
      )
    )
    .orderBy(asc(attendanceSessions.startedAt));

  return withBreaks(rows, tx);
};

/**
 * The most recent session the sweep closed, on the current business date or the
 * one before it — the thing the widget asks the person to correct.
 *
 * Yesterday is in scope because that is where the case actually lands: somebody
 * who forgets to clock out is swept in the small hours, and by the time they
 * read the notice the business date has moved on. It stops there rather than
 * reaching further back, since an older day is an admin's to fix anyway
 * (`docs/attendance.md`), and a notice nothing can clear would never leave.
 *
 * A session counts when the sweep closed it *or* when it holds a break the
 * sweep closed, because a break auto-closed inside an otherwise ordinary day is
 * just as wrong a number.
 */
const getAutoClosedSession = async (
  employmentId: string,
  businessDates: DateString[],
  tx?: DbTransaction
): Promise<AttendanceSessionView | undefined> => {
  const [row] = await (tx ?? db)
    .select(SESSION_COLUMNS)
    .from(attendanceSessions)
    .where(
      and(
        eq(attendanceSessions.employmentId, employmentId),
        inArray(attendanceSessions.businessDate, businessDates),
        isNull(attendanceSessions.deletedAt),
        or(
          eq(attendanceSessions.closedBy, attendanceClosedBy.Sweep),
          exists(
            (tx ?? db)
              .select({ one: sql`1` })
              .from(attendanceBreaks)
              .where(
                and(
                  eq(attendanceBreaks.sessionId, attendanceSessions.id),
                  eq(attendanceBreaks.autoClosed, true)
                )
              )
          )
        )
      )
    )
    .orderBy(desc(attendanceSessions.startedAt))
    .limit(1);

  if (!row) return undefined;

  const [view] = await withBreaks([row], tx);
  return view;
};

/**
 * The append-only record, written in the same transaction as the change it
 * describes. A null `changedByUserId` is the sweep; the ceiling sweep is the
 * one caller that is not a person.
 */
export const appendAttendanceEvent = async (
  entry: {
    sessionId: string;
    eventType: attendanceEventType;
    changedByUserId: string | null;
    before?: unknown;
    after?: unknown;
  },
  tx: DbTransaction
): Promise<void> => {
  await tx.insert(attendanceEvents).values({
    id: generateRandomUUID(),
    sessionId: entry.sessionId,
    eventType: entry.eventType,
    changedByUserId: entry.changedByUserId,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
};

/**
 * A `RETURNING` that came back empty after a statement that had to affect a
 * row. Nothing a caller can do about it, and nothing that should reach them as
 * an undefined.
 */
const written = <T>(row: T | undefined, what: string, context: { [key: string]: unknown }): T => {
  if (row) return row;
  throw new AppError({ message: `Failed to ${what}`, logging: true, code: 500, context });
};

const sessionAlreadyOpen = (session: AttendanceSessionType) =>
  conflict(
    "SESSION_ALREADY_OPEN",
    "You are already clocked in",
    { startedAt: session.startedAt.toISOString(), sessionId: session.id },
    { employmentId: session.employmentId }
  );

const noOpenSession = (employmentId: string) =>
  conflict("NO_OPEN_SESSION", "You are not clocked in", undefined, { employmentId });

export const clockIn = async (
  subject: AttendanceSubject & { timezone: string },
  actorUserId: string,
  tx: DbTransaction
): Promise<AttendanceSessionView> => {
  await lockEmployment(subject.employment.id, tx);

  const open = await getOpenSession(subject.employment.id, tx);
  if (open) throw sessionAlreadyOpen(open);

  const now = new Date();
  const businessDate = businessDateInZone(now, subject.timezone);

  const [inserted] = await tx
    .insert(attendanceSessions)
    .values({
      id: generateRandomUUID(),
      employmentId: subject.employment.id,
      businessDate,
      startedAt: now,
      timezone: subject.timezone,
    })
    .returning(SESSION_COLUMNS);
  const session = written(inserted, "clock in", { employmentId: subject.employment.id });

  await appendAttendanceEvent(
    {
      sessionId: session.id,
      eventType: attendanceEventType.ClockIn,
      changedByUserId: actorUserId,
      after: { startedAt: session.startedAt, businessDate, timezone: subject.timezone },
    },
    tx
  );

  return { ...session, breaks: [] };
};

/** Locks the clock and hands back the session the write acts on, or 409s. */
const requireOpenSession = async (
  subject: AttendanceSubject,
  tx: DbTransaction
): Promise<AttendanceSessionType> => {
  await lockEmployment(subject.employment.id, tx);

  const open = await getOpenSession(subject.employment.id, tx);
  if (!open) throw noOpenSession(subject.employment.id);

  return open;
};

export const clockOut = async (
  subject: AttendanceSubject,
  actorUserId: string,
  tx: DbTransaction
): Promise<AttendanceSessionView> => {
  const open = await requireOpenSession(subject, tx);
  const now = new Date();

  // An open break is counted to the clock-out instant rather than left
  // running, and is part of this one event rather than getting its own: one
  // click, one row. It is NOT flagged auto-closed — that flag is the sweep's,
  // and the correction dashboard reads it, so setting it here would file an
  // ordinary day as needing a fix.
  const openBreak = await getOpenBreak(open.id, tx);
  if (openBreak) {
    await tx
      .update(attendanceBreaks)
      .set({ endedAt: now })
      .where(eq(attendanceBreaks.id, openBreak.id));
  }

  const [updated] = await tx
    .update(attendanceSessions)
    .set({ endedAt: now, closedBy: attendanceClosedBy.User })
    .where(eq(attendanceSessions.id, open.id))
    .returning(SESSION_COLUMNS);
  const session = written(updated, "clock out", { sessionId: open.id });

  await appendAttendanceEvent(
    {
      sessionId: session.id,
      eventType: attendanceEventType.ClockOut,
      changedByUserId: actorUserId,
      before: { endedAt: null, closedBy: null },
      after: {
        endedAt: session.endedAt,
        closedBy: attendanceClosedBy.User,
        closedOpenBreakId: openBreak?.id ?? null,
      },
    },
    tx
  );

  const [view] = await withBreaks([session], tx);
  return view ?? { ...session, breaks: [] };
};

export const startBreak = async (
  subject: AttendanceSubject,
  actorUserId: string,
  tx: DbTransaction
): Promise<AttendanceBreakType> => {
  const open = await requireOpenSession(subject, tx);

  const running = await getOpenBreak(open.id, tx);
  if (running) {
    throw conflict(
      "BREAK_ALREADY_OPEN",
      "You are already on a break",
      { startedAt: running.startedAt.toISOString(), breakId: running.id },
      { sessionId: open.id }
    );
  }

  const [inserted] = await tx
    .insert(attendanceBreaks)
    .values({ id: generateRandomUUID(), sessionId: open.id, startedAt: new Date() })
    .returning(BREAK_COLUMNS);
  const entry = written(inserted, "start the break", { sessionId: open.id });

  await appendAttendanceEvent(
    {
      sessionId: open.id,
      eventType: attendanceEventType.BreakStart,
      changedByUserId: actorUserId,
      after: { breakId: entry.id, startedAt: entry.startedAt },
    },
    tx
  );

  return entry;
};

export const endBreak = async (
  subject: AttendanceSubject,
  actorUserId: string,
  tx: DbTransaction
): Promise<AttendanceBreakType> => {
  const open = await requireOpenSession(subject, tx);

  const running = await getOpenBreak(open.id, tx);
  if (!running) {
    throw conflict("NO_OPEN_BREAK", "You are not on a break", undefined, { sessionId: open.id });
  }

  const [updated] = await tx
    .update(attendanceBreaks)
    .set({ endedAt: new Date() })
    .where(eq(attendanceBreaks.id, running.id))
    .returning(BREAK_COLUMNS);
  const entry = written(updated, "end the break", { breakId: running.id });

  await appendAttendanceEvent(
    {
      sessionId: open.id,
      eventType: attendanceEventType.BreakEnd,
      changedByUserId: actorUserId,
      before: { breakId: entry.id, endedAt: null },
      after: { breakId: entry.id, endedAt: entry.endedAt },
    },
    tx
  );

  return entry;
};

/**
 * One read for the whole widget. Answers for an organization that never set
 * attendance up and for one whose plan has lapsed alike — `active` is the only
 * thing that changes, and the day stays readable either way.
 */
export const getAttendanceState = async (
  userId: string,
  organizationId: string | undefined,
  tx?: DbTransaction
): Promise<AttendanceStateType> => {
  const subject = await requireSubject(userId, organizationId, tx);
  const timezone = subject.settings?.timezone ?? null;

  const base = {
    organizationId: subject.organizationId,
    employmentId: subject.employment.id,
    employmentEnded: subject.employment.endedAt !== null,
    active: await isAttendanceActive(subject.organizationId, tx),
    locationEnabled: subject.settings?.locationEnabled ?? false,
    timezone,
  };

  if (!timezone) {
    return {
      ...base,
      businessDate: null,
      openSession: null,
      openBreak: null,
      sessions: [],
      autoClosedSession: null,
    };
  }

  const businessDate = businessDateInZone(new Date(), timezone);
  const sessions = await listSessionsForDate(subject.employment.id, businessDate, tx);
  const open = await getOpenSession(subject.employment.id, tx);
  // The open session belongs to today only when it started today: one left
  // running across midnight keeps yesterday's business date and so is not in
  // `sessions`, but it is still the thing the button acts on.
  const openSession = open
    ? (sessions.find((session) => session.id === open.id) ??
      (await withBreaks([open], tx))[0] ??
      null)
    : null;

  return {
    ...base,
    businessDate,
    openSession,
    openBreak: open ? ((await getOpenBreak(open.id, tx)) ?? null) : null,
    sessions,
    autoClosedSession:
      (await getAutoClosedSession(
        subject.employment.id,
        [previousDay(businessDate), businessDate],
        tx
      )) ?? null,
  };
};

/** Every session of an inclusive business-date range, oldest first. */
export const listSessionsForRange = async (
  employmentId: string,
  from: DateString,
  to: DateString,
  tx?: DbTransaction
): Promise<AttendanceSessionView[]> => {
  const rows = await (tx ?? db)
    .select(SESSION_COLUMNS)
    .from(attendanceSessions)
    .where(
      and(
        eq(attendanceSessions.employmentId, employmentId),
        gte(attendanceSessions.businessDate, from),
        lte(attendanceSessions.businessDate, to),
        isNull(attendanceSessions.deletedAt)
      )
    )
    .orderBy(asc(attendanceSessions.startedAt));

  return withBreaks(rows, tx);
};

/**
 * One month of the caller's own attendance: every business date in it, the
 * sessions that fall on it, and the figures `attendanceCalculation` works out
 * from them.
 *
 * Never gated by the plan, like every other attendance read — a lapsed
 * organization's history is the last thing anyone should lose.
 *
 * An organization that never set attendance up has no zone and so no sessions
 * either. It answers with the month's dates against the documented defaults
 * rather than a 404, the way the settings read does, and carries
 * `timezone: null` so the screen can say why the month is empty.
 */
export const getAttendanceMonth = async (
  userId: string,
  query: { organizationId?: string; year: number; month: number },
  tx?: DbTransaction
): Promise<AttendanceMonthType> => {
  const subject = await requireSubject(userId, query.organizationId, tx);
  const settings = { ...ATTENDANCE_SETTINGS_DEFAULTS, ...subject.settings };

  const from = monthStart(query.year, query.month);
  const to = monthEnd(query.year, query.month);
  const sessions = await listSessionsForRange(subject.employment.id, from, to, tx);

  const now = new Date();
  // No zone means no session could ever have been recorded, so UTC decides only
  // which of an empty month's days are still to come.
  const timezone = settings.timezone ?? "UTC";
  const { days, totals } = computeAttendance({
    dates: expandDateRangeInclusive(from, to),
    sessions,
    rules: {
      breakMinutes: settings.breakMinutes,
      breakThresholdMinutes: settings.breakThresholdMinutes,
      requiredMinutesPerDay: settings.requiredMinutesPerDay,
      requiredMinutesOverride: subject.employment.requiredMinutesPerDay,
      balanceMode: settings.balanceMode,
    },
    timezone,
    now,
  });

  return {
    organizationId: subject.organizationId,
    employmentId: subject.employment.id,
    timezone: settings.timezone,
    businessDate: settings.timezone ? businessDateInZone(now, settings.timezone) : null,
    year: query.year,
    month: query.month,
    balanceMode: settings.balanceMode,
    requiredMinutesPerDay:
      subject.employment.requiredMinutesPerDay ?? settings.requiredMinutesPerDay,
    requiredMinutesOverride: subject.employment.requiredMinutesPerDay,
    breakMinutes: settings.breakMinutes,
    breakThresholdMinutes: settings.breakThresholdMinutes,
    days: days.map((day) => ({
      ...day,
      sessions: sessions.filter((session) => session.businessDate === day.businessDate),
    })),
    totals,
  };
};

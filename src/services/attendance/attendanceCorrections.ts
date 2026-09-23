import { asc, eq } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import {
  attendanceBreaks,
  attendanceClosedBy,
  attendanceEventType,
  attendanceEvents,
  attendanceSessions,
} from "../../db/schema/attendance-schema.js";
import { user } from "../../db/schema/auth-schema.js";
import AppError from "../../utils/appError.js";
import { businessDateInZone } from "../../utils/dateFunc.js";
import { buildUserSummary } from "../../utils/userPresentation.js";
import { assertAttendanceActive } from "../billing/guards.js";
import {
  assertEmploymentReadable,
  canAdministerEmployment,
} from "../employment/attendanceAccess.js";
import { getEmploymentById } from "../employment/employmentServices.js";
import { getAttendanceSettings } from "../organization/attendanceSettingsServices.js";
import {
  appendAttendanceEvent,
  attendanceConflict,
  getBreakById,
  getOpenBreak,
  getOpenSession,
  getSessionById,
  listBreaksForSession,
  listSessionsOverlapping,
  lockEmployment,
  sessionAlreadyOpen,
} from "./attendanceServices.js";
import {
  AttendanceCorrectionRight,
  type AttendanceBreakType,
  type AttendanceEventView,
  type AttendanceSessionType,
  type AttendanceSessionView,
  type ValidatedAttendanceCorrectionType,
} from "./types.js";
import {
  selfServiceRefusal,
  selfServiceWindowOf,
  type SelfServiceRefusal,
  type SelfServiceWindow,
} from "./selfServiceWindow.js";

/** A start and an end, which is all the shape rules below actually read. */
type Span = { startedAt: Date; endedAt: Date | null };

/**
 * The session a correction acts on, everything the guards need, and under whose
 * authority it is being made.
 */
type CorrectionSubject = {
  session: AttendanceSessionType;
  breaks: AttendanceBreakType[];
  employment: { id: string; organizationId: string; userId: string };
  right: AttendanceCorrectionRight;
  /** The organization's zone now, which is what "today" is read in. */
  timezone: string;
};

const invalid = (reason: string, message: string, context?: { [key: string]: unknown }) =>
  new AppError({
    message,
    logging: true,
    code: 422,
    context,
    publicContext: { reason },
  });

/**
 * A patch over a span. An absent key leaves what is there; an explicit
 * `endedAt: null` reopens, which is why the two are told apart by the key's
 * presence rather than by its value.
 */
export const applyCorrection = (span: Span, patch: ValidatedAttendanceCorrectionType): Span => ({
  startedAt: patch.startedAt === undefined ? span.startedAt : new Date(patch.startedAt),
  endedAt: "endedAt" in patch ? (patch.endedAt ? new Date(patch.endedAt) : null) : span.endedAt,
});

/**
 * The shape a session and its breaks have to keep, whichever end the correction
 * came in through: an end after its start, and every break inside the session
 * that holds it. Both are 422s — the numbers do not describe a day anybody
 * could have worked — where a clash with another row is a 409.
 *
 * An open break under a closed session is left alone rather than refused: the
 * sweep makes them, and the calculation counts one to the session's close.
 */
export const assertCoherent = (session: Span, breaks: (Span & { id: string })[]): void => {
  if (session.endedAt !== null && session.endedAt <= session.startedAt) {
    throw invalid("END_BEFORE_START", "A session has to end after it starts");
  }

  for (const entry of breaks) {
    if (entry.endedAt !== null && entry.endedAt <= entry.startedAt) {
      throw invalid("END_BEFORE_START", "A break has to end after it starts", {
        breakId: entry.id,
      });
    }

    const startsBefore = entry.startedAt < session.startedAt;
    const endsAfter =
      session.endedAt !== null && (entry.endedAt ?? session.endedAt) > session.endedAt;
    const startsAfter = session.endedAt !== null && entry.startedAt >= session.endedAt;

    if (startsBefore || endsAfter || startsAfter) {
      throw invalid("BREAK_OUTSIDE_SESSION", "A break has to stay inside its session", {
        breakId: entry.id,
      });
    }
  }
};

const sessionNotFound = (sessionId: string, viewerUserId: string) =>
  new AppError({
    message: "Session not found",
    logging: true,
    code: 404,
    context: { sessionId, viewerUserId },
  });

const breakNotFound = (breakId: string, viewerUserId: string) =>
  new AppError({
    message: "Break not found",
    logging: true,
    code: 404,
    context: { breakId, viewerUserId },
  });

const employmentMissing = (employmentId: string) =>
  new AppError({
    message: "Employment not found",
    logging: true,
    code: 500,
    context: { employmentId },
  });

const forbidden = (message: string, context: { [key: string]: unknown }, reason?: string) =>
  new AppError({
    message,
    logging: true,
    code: 403,
    context,
    publicContext: reason ? { reason } : undefined,
  });

/**
 * Loads the session a correction names, decides who is correcting it, and takes
 * the Employment's clock for the rest of the transaction — the same lock a
 * clock-in takes, in the same order, so an edit that reopens a session and a
 * clock-in cannot both find nothing open.
 *
 * The plan gate applies: a correction is a write, and a lapsed organization's
 * history is readable rather than editable. An ended Employment is refused only
 * its owner — the last day somebody worked is exactly the one an admin is most
 * likely to be fixing.
 */
const loadCorrectable = async (
  viewerUserId: string,
  sessionId: string,
  tx: DbTransaction,
  now: Date
): Promise<CorrectionSubject> => {
  const found = await getSessionById(sessionId, {}, tx);
  if (!found) throw sessionNotFound(sessionId, viewerUserId);

  const employment = await getEmploymentById(found.employmentId, tx);
  if (!employment) throw employmentMissing(found.employmentId);

  await assertAttendanceActive(employment.organizationId, tx);

  const settings = await getAttendanceSettings(employment.organizationId, tx);
  // The organization's zone as it stands now, falling back to the one the
  // session was clocked in under: today is a question about the organization,
  // not about the session.
  const timezone = settings?.timezone ?? found.timezone;

  const right = await resolveCorrectionRight(viewerUserId, employment, found, tx, {
    window: selfServiceWindowOf(settings),
    timezone,
    now,
  });

  await lockEmployment(employment.id, tx);

  // Re-read behind the lock: a clock-out, the sweep or another admin may have
  // moved this session between the read above and the lock. Gone means gone —
  // falling back to the row read before the lock would let a correction write
  // over a session somebody deleted while it waited.
  const session = await getSessionById(sessionId, {}, tx);
  if (!session) throw sessionNotFound(sessionId, viewerUserId);

  return {
    session,
    breaks: await listBreaksForSession(sessionId, tx),
    employment,
    right,
    timezone,
  };
};

const selfServiceMessage = (refusal: SelfServiceRefusal): string => {
  switch (refusal) {
    case "EMPLOYMENT_ENDED":
      return "Your employment here has ended. Your attendance stays readable, and only an admin can change it.";
    case "SELF_SERVICE_OFF":
      return "Your organization manages attendance corrections through an admin. Ask a group admin, or an organization admin.";
    case "SELF_SERVICE_WINDOW":
      return "Only an admin can change a day this old. Ask a group admin, or an organization admin.";
  }
};

const resolveCorrectionRight = async (
  viewerUserId: string,
  employment: { organizationId: string; userId: string; endedAt: Date | null },
  session: AttendanceSessionType,
  tx: DbTransaction,
  selfService: { window: SelfServiceWindow; timezone: string; now: Date }
): Promise<AttendanceCorrectionRight> => {
  if (await canAdministerEmployment(viewerUserId, employment, tx)) {
    return AttendanceCorrectionRight.Admin;
  }

  if (viewerUserId !== employment.userId) {
    throw forbidden("No permission for this employment", {
      viewerUserId,
      organizationId: employment.organizationId,
      target: employment.userId,
    });
  }

  const refusal = selfServiceRefusal({
    session,
    employmentEnded: employment.endedAt !== null,
    ...selfService,
  });

  if (refusal) {
    throw forbidden(
      selfServiceMessage(refusal),
      { viewerUserId, sessionId: session.id, businessDate: session.businessDate },
      refusal
    );
  }

  return AttendanceCorrectionRight.Self;
};

/** The session as it now stands, with its breaks — what every correction answers with. */
const sessionView = async (
  sessionId: string,
  tx: DbTransaction
): Promise<AttendanceSessionView> => {
  const session = await getSessionById(sessionId, { includeDeleted: true }, tx);
  if (!session) {
    throw new AppError({
      message: "Failed to correct the session",
      logging: true,
      code: 500,
      context: { sessionId },
    });
  }

  return { ...session, breaks: await listBreaksForSession(sessionId, tx) };
};

/**
 * Moves a clock-in, a clock-out, or both.
 *
 * `businessDate` does not move with them. It is fixed at clock-in and never
 * recomputed (`docs/attendance.md`), so a correction changes what a day holds
 * rather than which day holds it.
 *
 * Closing a session records who closed it, which is how a swept session stops
 * being flagged: the sweep's `SWEEP` gives way to the person who overruled it.
 */
export const correctAttendanceSession = async (
  viewerUserId: string,
  sessionId: string,
  patch: ValidatedAttendanceCorrectionType,
  tx: DbTransaction,
  now = new Date()
): Promise<AttendanceSessionView> => {
  const { session, breaks, right } = await loadCorrectable(viewerUserId, sessionId, tx, now);

  const next = applyCorrection(session, patch);
  assertCoherent(next, breaks);

  if (session.endedAt !== null && next.endedAt === null) {
    const open = await getOpenSession(session.employmentId, tx);
    if (open && open.id !== session.id) throw sessionAlreadyOpen(open);
  }

  // Nothing in the schema stops two spans of one Employment covering the same
  // minutes, and `presence` would count them twice. Only a correction can make
  // that shape, so this is where it is refused.
  const [overlap] = await listSessionsOverlapping(session.employmentId, next, session.id, tx);
  if (overlap) {
    throw attendanceConflict(
      "SESSION_OVERLAPS",
      "Another session of theirs already covers that time",
      {
        sessionId: overlap.id,
        startedAt: overlap.startedAt.toISOString(),
        endedAt: overlap.endedAt?.toISOString() ?? null,
      },
      { employmentId: session.employmentId }
    );
  }

  const closedBy = closedByAfter(session, next, patch, right);

  await tx
    .update(attendanceSessions)
    .set({ startedAt: next.startedAt, endedAt: next.endedAt, closedBy })
    .where(eq(attendanceSessions.id, session.id));

  await appendAttendanceEvent(
    {
      sessionId: session.id,
      eventType: attendanceEventType.SessionEdited,
      changedByUserId: viewerUserId,
      before: {
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        closedBy: session.closedBy,
      },
      after: { startedAt: next.startedAt, endedAt: next.endedAt, closedBy },
    },
    tx
  );

  return sessionView(session.id, tx);
};

/**
 * Who a corrected session now reads as closed by. Untouched while the patch
 * leaves the end alone, so moving only a clock-in does not quietly clear the
 * sweep's mark on an end nobody has looked at.
 */
const closedByAfter = (
  session: AttendanceSessionType,
  next: Span,
  patch: ValidatedAttendanceCorrectionType,
  right: AttendanceCorrectionRight
): attendanceClosedBy | null => {
  if (!("endedAt" in patch)) return session.closedBy;
  if (next.endedAt === null) return null;
  return right === AttendanceCorrectionRight.Admin
    ? attendanceClosedBy.Admin
    : attendanceClosedBy.User;
};

/**
 * Moves a break's own times. Correcting its end clears `autoClosed` — the flag
 * is the sweep's claim that nobody has checked this number, and somebody just
 * has.
 */
export const correctAttendanceBreak = async (
  viewerUserId: string,
  breakId: string,
  patch: ValidatedAttendanceCorrectionType,
  tx: DbTransaction,
  now = new Date()
): Promise<AttendanceSessionView> => {
  // Read once for its session id, then again from what the lock returned: a
  // patch that names one end writes the other back as it stands, and "as it
  // stands" has to mean behind the lock or a sweep close is silently undone.
  const named = await getBreakById(breakId, tx);
  if (!named) throw breakNotFound(breakId, viewerUserId);

  const { session, breaks } = await loadCorrectable(viewerUserId, named.sessionId, tx, now);

  const entry = breaks.find((candidate) => candidate.id === breakId);
  if (!entry) throw breakNotFound(breakId, viewerUserId);

  const next = applyCorrection(entry, patch);
  assertCoherent(
    session,
    breaks.map((candidate) => (candidate.id === entry.id ? { ...candidate, ...next } : candidate))
  );

  if (entry.endedAt !== null && next.endedAt === null) {
    const open = await getOpenBreak(session.id, tx);
    if (open && open.id !== entry.id) {
      throw attendanceConflict(
        "BREAK_ALREADY_OPEN",
        "Another break on this session is still open",
        { breakId: open.id, startedAt: open.startedAt.toISOString() },
        { sessionId: session.id }
      );
    }
  }

  const autoClosed = "endedAt" in patch ? false : entry.autoClosed;

  await tx
    .update(attendanceBreaks)
    .set({ startedAt: next.startedAt, endedAt: next.endedAt, autoClosed })
    .where(eq(attendanceBreaks.id, entry.id));

  await appendAttendanceEvent(
    {
      sessionId: session.id,
      eventType: attendanceEventType.BreakEdited,
      changedByUserId: viewerUserId,
      before: {
        breakId: entry.id,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        autoClosed: entry.autoClosed,
      },
      after: {
        breakId: entry.id,
        startedAt: next.startedAt,
        endedAt: next.endedAt,
        autoClosed,
      },
    },
    tx
  );

  return sessionView(session.id, tx);
};

/**
 * Takes a break off its session. The row goes; the event that says it was there
 * and who removed it stays, which is the only record left of it.
 */
export const deleteAttendanceBreak = async (
  viewerUserId: string,
  breakId: string,
  tx: DbTransaction,
  now = new Date()
): Promise<AttendanceSessionView> => {
  const named = await getBreakById(breakId, tx);
  if (!named) throw breakNotFound(breakId, viewerUserId);

  const { session, breaks } = await loadCorrectable(viewerUserId, named.sessionId, tx, now);

  // Behind the lock, so the payload records what was actually removed.
  const entry = breaks.find((candidate) => candidate.id === breakId);
  if (!entry) throw breakNotFound(breakId, viewerUserId);

  await tx.delete(attendanceBreaks).where(eq(attendanceBreaks.id, entry.id));

  await appendAttendanceEvent(
    {
      sessionId: session.id,
      eventType: attendanceEventType.BreakDeleted,
      changedByUserId: viewerUserId,
      before: {
        breakId: entry.id,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        autoClosed: entry.autoClosed,
      },
    },
    tx
  );

  return sessionView(session.id, tx);
};

/**
 * Soft-deletes a session clocked by mistake. The row stays, and so do its
 * events and its breaks — every read filters `deletedAt`, and the timeline is
 * the one thing a delete may not take away.
 *
 * Deleting an open session frees the clock: the unique index that holds "one
 * open session per Employment" excludes deleted rows.
 */
export const deleteAttendanceSession = async (
  viewerUserId: string,
  sessionId: string,
  tx: DbTransaction,
  now = new Date()
): Promise<AttendanceSessionView> => {
  const { session, right, timezone } = await loadCorrectable(viewerUserId, sessionId, tx, now);

  // A clocked session from a past day can be corrected by its owner but not
  // removed, so a real clock-in never vanishes at their hand.
  if (
    right === AttendanceCorrectionRight.Self &&
    session.businessDate !== businessDateInZone(now, timezone)
  ) {
    throw forbidden(
      "This session was clocked on an earlier day. You can correct its times, but only an admin can delete it.",
      { viewerUserId, sessionId: session.id, businessDate: session.businessDate },
      "SELF_SERVICE_DELETE"
    );
  }

  await tx
    .update(attendanceSessions)
    .set({ deletedAt: now, deletedByUserId: viewerUserId })
    .where(eq(attendanceSessions.id, session.id));

  await appendAttendanceEvent(
    {
      sessionId: session.id,
      eventType: attendanceEventType.SessionDeleted,
      changedByUserId: viewerUserId,
      before: { startedAt: session.startedAt, endedAt: session.endedAt, deletedAt: null },
      after: { deletedAt: now },
    },
    tx
  );

  return sessionView(session.id, tx);
};

/**
 * A session's timeline, oldest first, with the person behind each entry. Read
 * rights, not correction rights: an employee reads their own history however
 * old it is, and only changing it needs the window.
 *
 * A soft-deleted session still answers. Its last entry is the delete, and
 * hiding the trail of a session somebody removed would defeat the point of
 * keeping the row.
 */
export const listAttendanceSessionEvents = async (
  viewerUserId: string,
  sessionId: string,
  tx?: DbTransaction
): Promise<AttendanceEventView[]> => {
  const session = await getSessionById(sessionId, { includeDeleted: true }, tx);
  if (!session) throw sessionNotFound(sessionId, viewerUserId);

  const employment = await getEmploymentById(session.employmentId, tx);
  if (!employment) throw employmentMissing(session.employmentId);

  await assertEmploymentReadable(viewerUserId, employment, tx);

  const rows = await (tx ?? db)
    .select({
      id: attendanceEvents.id,
      sessionId: attendanceEvents.sessionId,
      eventType: attendanceEvents.eventType,
      before: attendanceEvents.before,
      after: attendanceEvents.after,
      createdAt: attendanceEvents.createdAt,
      userId: user.id,
      userName: user.name,
    })
    .from(attendanceEvents)
    .leftJoin(user, eq(attendanceEvents.changedByUserId, user.id))
    .where(eq(attendanceEvents.sessionId, sessionId))
    .orderBy(asc(attendanceEvents.createdAt));

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.sessionId,
    eventType: row.eventType,
    user: row.userId ? buildUserSummary({ id: row.userId, name: row.userName ?? "" }) : null,
    before: row.before,
    after: row.after,
    createdAt: row.createdAt,
  }));
};

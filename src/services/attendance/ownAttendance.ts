import { db, type DbTransaction } from "../../db/db.js";
import type { AuthSession } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import {
  beginAttendanceWrite,
  clockIn,
  clockOut,
  getAttendanceDay,
  getAttendanceMonth,
  getAttendanceState,
  previewClockIn,
  previewClockOut,
  type ClockInPreview,
  type ClockOutPreview,
} from "./attendanceServices.js";
import type {
  AttendanceDayType,
  AttendanceMonthType,
  AttendanceSessionView,
  AttendanceStateType,
  ValidatedAttendanceDayQueryType,
  ValidatedAttendanceMonthQueryType,
} from "./types.js";

type OwnClock = { auth: AuthSession; organizationId: string | undefined };

type WriteSubject = Awaited<ReturnType<typeof beginAttendanceWrite>>;

/** One clock write or dry run in its own transaction, after the write checks for its kind. */
const onOwnClock = <T>(
  kind: "OPEN" | "CLOSE",
  { auth, organizationId }: OwnClock,
  run: (subject: WriteSubject, tx: DbTransaction) => Promise<T>
): Promise<T> =>
  db.transaction(async (tx) =>
    run(await beginAttendanceWrite(auth.userId, organizationId, tx, kind), tx)
  );

/** Starts a session at the server's instant. The business date is fixed from the organization's zone. */
export const clockInOwn = (params: OwnClock): Promise<AttendanceSessionView> =>
  onOwnClock("OPEN", params, (subject, tx) => clockIn(subject, params.auth, tx));

export const clockOutOwn = (params: OwnClock): Promise<AttendanceSessionView> =>
  onOwnClock("CLOSE", params, (subject, tx) => clockOut(subject, params.auth, tx));

/** {@link clockInOwn} as a dry run: the same checks, nothing written. */
export const previewClockInOwn = (params: OwnClock): Promise<ClockInPreview> =>
  onOwnClock("OPEN", params, previewClockIn);

/** {@link clockOutOwn} as a dry run: the same checks, nothing written. */
export const previewClockOutOwn = (params: OwnClock): Promise<ClockOutPreview> =>
  onOwnClock("CLOSE", params, previewClockOut);

/** The clock widget's read. Never gated by the plan, so a lapsed organization still reads `active: false`. */
export const readOwnAttendanceState = async (params: {
  auth: AuthSession;
  organizationId: string | undefined;
}): Promise<AttendanceStateType> => getAttendanceState(params.auth.userId, params.organizationId);

/**
 * One month of the caller's own attendance, and nobody else's: an admin reads
 * somebody else's through the team dashboard, which carries the visibility
 * matrix. Naming another `userId` is refused rather than ignored, so a caller
 * is never shown their own month believing it is a colleague's.
 */
export const readOwnAttendanceMonth = async (params: {
  auth: AuthSession;
  query: ValidatedAttendanceMonthQueryType;
}): Promise<AttendanceMonthType> => {
  const { auth } = params;
  const { userId, ...query } = params.query;

  if (userId !== undefined && userId !== auth.userId) {
    throw new AppError({
      message: "This month is only your own",
      logging: true,
      code: 403,
      context: { userId: auth.userId, target: userId },
      publicContext: { reason: "OWN_EMPLOYMENT_ONLY" },
    });
  }

  return getAttendanceMonth(auth.userId, query);
};

/** One person's sessions on one business date; the caller's own unless they may read the named person's. */
export const readAttendanceDay = async (params: {
  auth: AuthSession;
  query: ValidatedAttendanceDayQueryType;
}): Promise<AttendanceDayType> => getAttendanceDay(params.auth.userId, params.query);

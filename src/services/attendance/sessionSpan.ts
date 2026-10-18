import { ATTENDANCE_SETTINGS_DEFAULTS } from "../../db/schema/organization-attendance-settings-schema.js";
import AppError from "../../utils/appError.js";
import { businessDateInZone, type DateString } from "../../utils/dateFunc.js";

type Span = { startedAt: Date; endedAt: Date | null };

export type SpanRefusal =
  "START_OFF_DATE" | "START_IN_FUTURE" | "END_BEFORE_START" | "END_IN_FUTURE" | "OVER_CEILING";

export const sessionCeilingMinutesOf = (
  settings: { sessionCeilingMinutes: number } | undefined
): number => settings?.sessionCeilingMinutes ?? ATTENDANCE_SETTINGS_DEFAULTS.sessionCeilingMinutes;

/**
 * Nothing later than now: the end, or while the span is still open, its start.
 * Read after the end-after-start rule, so the end is the latest instant named.
 */
export const pastNowRefusal = (span: Span, now: Date): SpanRefusal | null => {
  if ((span.endedAt ?? span.startedAt) <= now) return null;
  return span.endedAt === null ? "START_IN_FUTURE" : "END_IN_FUTURE";
};

/**
 * Where a session's times may fall, whether entered or corrected: the start on
 * its business date in `timezone`, nothing after now, and no longer than the
 * ceiling. Strictly longer: the sweep closes a session at exactly
 * `startedAt + ceiling`, and that close has to stay correctable. A session still
 * open has no length yet, so the ceiling waits for the sweep.
 */
export const spanRefusal = ({
  businessDate,
  startedAt,
  endedAt,
  timezone,
  now,
  ceilingMinutes,
}: Span & {
  businessDate: DateString;
  timezone: string;
  now: Date;
  ceilingMinutes: number;
}): SpanRefusal | null => {
  if (businessDateInZone(startedAt, timezone) !== businessDate) return "START_OFF_DATE";
  if (endedAt !== null && endedAt <= startedAt) return "END_BEFORE_START";

  const pastNow = pastNowRefusal({ startedAt, endedAt }, now);
  if (pastNow) return pastNow;

  if (endedAt !== null && endedAt.getTime() - startedAt.getTime() > ceilingMinutes * 60_000) {
    return "OVER_CEILING";
  }
  return null;
};

const hoursAndMinutes = (minutes: number): string =>
  `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;

/** The wording for a correction; an entry words the date and now rules its own way. */
export const spanMessage = (refusal: SpanRefusal, ceilingMinutes: number): string => {
  switch (refusal) {
    case "START_OFF_DATE":
      return "A correction moves times, not days. The session has to start on its own day.";
    case "START_IN_FUTURE":
    case "END_IN_FUTURE":
      return "A corrected time can't be later than now";
    case "END_BEFORE_START":
      return "A session has to end after it starts";
    case "OVER_CEILING":
      return `A session can't be longer than ${hoursAndMinutes(ceilingMinutes)}, the organization's session limit`;
  }
};

export const spanRefused = ({
  reason,
  message,
  ceilingMinutes,
  context,
}: {
  reason: string;
  message: string;
  ceilingMinutes: number;
  context: { [key: string]: unknown };
}): AppError =>
  new AppError({
    message,
    logging: true,
    code: 422,
    context,
    publicContext: { reason, ...(reason === "OVER_CEILING" ? { ceilingMinutes } : {}) },
  });

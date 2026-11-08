import { z } from "zod";

const DAY_MS = 24 * 60 * 60 * 1000;

export const isoDay = z.iso.date();

type DayRange = { from: string; to: string };

const ordered = (value: unknown) => (value as DayRange).to >= (value as DayRange).from;

const spanDays = (value: unknown) =>
  (Date.parse((value as DayRange).to) - Date.parse((value as DayRange).from)) / DAY_MS + 1;

// Compare the days only once both parsed, so a bad `from` is not reported against `to` too.
const valid = ({ issues }: { issues: unknown[] }) => issues.length === 0;

/** An input with inclusive `from` and `to` days at most `maxDays` days long, plus `shape`. */
export const withDayRange = <Shape extends z.ZodRawShape>(maxDays: number, shape: Shape) =>
  z
    .object({
      from: isoDay.describe("First day, inclusive, as YYYY-MM-DD."),
      to: isoDay.describe(
        `Last day, inclusive, as YYYY-MM-DD. The range covers at most ${maxDays.toString()} days.`
      ),
      ...shape,
    })
    .refine(ordered, { path: ["to"], when: valid })
    .refine((value) => spanDays(value) <= maxDays, { path: ["to"], when: valid });

/** The half-open range the request services take. */
export const toHalfOpen = ({ from, to }: { from: string; to: string }) => ({
  startDate: from,
  endDate: new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10),
});

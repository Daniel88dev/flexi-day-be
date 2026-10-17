import { z } from "zod";
import type { UserSummary } from "../../utils/userPresentation.js";
import { vacationQueryMonth, vacationQueryYear } from "../vacation/types.js";
import { monthPosition, weekdayOf, type IsoDate, type RepeatRule } from "./occurrences.js";

export const GROUP_EVENT_TITLE_MAX = 100;
export const GROUP_EVENT_NOTE_MAX = 1000;
/** S6: no `group_events` query reads more rows than this per call. */
export const GROUP_EVENT_READ_LIMIT = 500;

export type GroupEventRecord = {
  id: string;
  groupId: string;
  createdByUserId: string | null;
  title: string | null;
  note: string | null;
  startDate: IsoDate;
  endDate: IsoDate;
  startTime: string | null;
  endTime: string | null;
  repeatFreq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY" | null;
  repeatInterval: number | null;
  repeatWeekdays: number[] | null;
  repeatMonthlyMode: "DAY" | "NTH_WEEKDAY" | "LAST_WEEKDAY" | null;
  repeatUntil: IsoDate | null;
  skippedDates: IsoDate[];
  recurringEventId: string | null;
  originalDate: IsoDate | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

/** One row of `GET /api/group-events`. Clients expand `repeat` themselves. */
export type GroupEventView = {
  id: string;
  groupId: string;
  groupName: string;
  title: string;
  note: string | null;
  startDate: IsoDate;
  endDate: IsoDate;
  /** `HH:MM`; both null on an all-day event. */
  startTime: string | null;
  endTime: string | null;
  repeat: RepeatRule | null;
  skippedDates: IsoDate[];
  recurringEventId: string | null;
  originalDate: IsoDate | null;
  /** Null once the creator deleted their account (S5). */
  createdBy: UserSummary | null;
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GroupEventGroup = { groupId: string; groupName: string; canCreate: boolean };

const isoDate = z.iso
  .date()
  .refine((value) => value >= "2000-01-01" && value <= "2100-12-31", "Date out of range");

const clockTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Expected HH:MM")
  .transform((value) => value.slice(0, 5));

const repeatRuleInput = z.object({
  freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().min(1).max(99),
  weekdays: z.array(z.number().int().min(0).max(6)).optional(),
  monthlyMode: z.enum(["day", "weekday", "lastWeekday"]).nullable().optional(),
  until: isoDate.nullable().optional(),
});

const optionalNote = z
  .string()
  .trim()
  .max(GROUP_EVENT_NOTE_MAX)
  .nullable()
  .optional()
  .transform((value) => (value ? value : null));

/** Body of `POST /api/group-events`. Weekly weekdays come back sorted, other rules' extras dropped. */
export const validateCreateGroupEvent = z
  .object({
    groupId: z.uuid(),
    title: z.string().trim().min(1).max(GROUP_EVENT_TITLE_MAX),
    note: optionalNote,
    startDate: isoDate,
    endDate: isoDate.optional(),
    startTime: clockTime.nullable().optional(),
    endTime: clockTime.nullable().optional(),
    repeat: repeatRuleInput.nullable().optional(),
  })
  .transform((data) => ({
    groupId: data.groupId,
    title: data.title,
    note: data.note,
    startDate: data.startDate,
    endDate: data.endDate ?? data.startDate,
    startTime: data.startTime ?? null,
    endTime: data.endTime ?? null,
    repeat: data.repeat
      ? {
          freq: data.repeat.freq,
          interval: data.repeat.interval,
          weekdays:
            data.repeat.freq === "weekly"
              ? [...new Set(data.repeat.weekdays ?? [])].sort((a, b) => a - b)
              : [],
          monthlyMode: data.repeat.freq === "monthly" ? (data.repeat.monthlyMode ?? null) : null,
          until: data.repeat.until ?? null,
        }
      : null,
  }))
  .superRefine((data, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });

    if (data.endDate < data.startDate) issue("endDate", "`endDate` must not be before `startDate`");
    if ((data.startTime === null) !== (data.endTime === null)) {
      issue("endTime", "Give both `startTime` and `endTime`, or neither");
    } else if (
      data.startTime !== null &&
      data.endTime !== null &&
      data.startDate === data.endDate &&
      data.endTime <= data.startTime
    ) {
      issue("endTime", "`endTime` must be later than `startTime` on a single day");
    }

    const rule = data.repeat;
    if (!rule) return;
    if (data.endDate !== data.startDate) {
      issue("repeat", "A recurring group event lasts one day");
    }
    if (rule.until !== null && rule.until < data.startDate) {
      issue("repeat", "`repeat.until` must not be before `startDate`");
    }
    if (rule.freq === "weekly" && !rule.weekdays.includes(weekdayOf(data.startDate))) {
      issue("repeat", "A weekly rule must include the start date's weekday");
    }
    if (rule.freq === "monthly") {
      const { nth, isLast } = monthPosition(data.startDate);
      if (rule.monthlyMode === null) {
        issue("repeat", "A monthly rule needs `monthlyMode`");
      } else if (rule.monthlyMode === "weekday" && nth > 4) {
        issue("repeat", "A start on the 5th weekday of its month repeats only as `lastWeekday`");
      } else if (rule.monthlyMode === "lastWeekday" && !isLast) {
        issue("repeat", "`lastWeekday` needs a start on the last such weekday of its month");
      }
    }
  });

export type CreateGroupEventBody = z.infer<typeof validateCreateGroupEvent>;

/** Query of `GET /api/group-events`: one month, every group of the caller's or one. */
export const validateGroupEventsQuery = z.object({
  year: vacationQueryYear,
  month: vacationQueryMonth,
  groupId: z.uuid().optional(),
});

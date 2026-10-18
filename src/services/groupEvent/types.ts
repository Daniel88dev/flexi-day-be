import { z } from "zod";
import type { groupEvents } from "../../db/schema/group-event-schema.js";
import type { UserSummary } from "../../utils/userPresentation.js";
import { vacationQueryMonth, vacationQueryYear } from "../vacation/types.js";
import { monthPosition, weekdayOf, type IsoDate, type RepeatRule } from "./occurrences.js";

export const GROUP_EVENT_TITLE_MAX = 100;
export const GROUP_EVENT_NOTE_MAX = 1000;
/** No `group_events` query reads more rows than this per call. */
export const GROUP_EVENT_READ_LIMIT = 500;

export type GroupEventColumns = Partial<typeof groupEvents.$inferInsert>;

/**
 * The writes one edit or delete makes, computed without touching the database
 * so `PATCH` and its `impact` dry run agree on `droppedOneOffs`.
 */
export type GroupEventPlan = {
  droppedOneOffs: number;
  updates: { id: string; set: GroupEventColumns }[];
  inserts: (GroupEventColumns & {
    id: string;
    groupId: string;
    startDate: IsoDate;
    endDate: IsoDate;
  })[];
  tombstones: string[];
  /**
   * The edit adds occurrences: a "this and following" split writes a new group
   * event, or a one-off gains a repeat rule. Only these need an active plan.
   */
  needsActivePlan: boolean;
};

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
  /** Null once the creator deleted their account. */
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

type RepeatRuleInput = z.infer<typeof repeatRuleInput>;

/** Weekly weekdays sorted and deduplicated; fields other rules do not use dropped. */
const normalizeRepeat = (rule: RepeatRuleInput): RepeatRule => ({
  freq: rule.freq,
  interval: rule.interval,
  weekdays: rule.freq === "weekly" ? [...new Set(rule.weekdays ?? [])].sort((a, b) => a - b) : [],
  monthlyMode: rule.freq === "monthly" ? (rule.monthlyMode ?? null) : null,
  until: rule.until ?? null,
});

/** The content of a live group event, as create takes it and an edit produces it. */
export type GroupEventShape = {
  title: string;
  note: string | null;
  startDate: IsoDate;
  endDate: IsoDate;
  startTime: string | null;
  endTime: string | null;
  repeat: RepeatRule | null;
};

/**
 * The rules on dates, times and repeat a shape breaks, beyond what each field
 * checks on its own.
 */
export const groupEventShapeIssues = (
  data: Omit<GroupEventShape, "title" | "note">
): { path: string; message: string }[] => {
  const issues: { path: string; message: string }[] = [];
  const issue = (path: string, message: string) => issues.push({ path, message });

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
  if (!rule) return issues;
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
  return issues;
};

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
    repeat: data.repeat ? normalizeRepeat(data.repeat) : null,
  }))
  .superRefine((data, ctx) => {
    for (const { path, message } of groupEventShapeIssues(data)) {
      ctx.addIssue({ code: "custom", path: [path], message });
    }
  });

export type CreateGroupEventBody = z.infer<typeof validateCreateGroupEvent>;

/** Query of `GET /api/group-events`: one month, every group of the caller's or one. */
export const validateGroupEventsQuery = z.object({
  year: vacationQueryYear,
  month: vacationQueryMonth,
  groupId: z.uuid().optional(),
});

const groupEventScope = z.enum(["this", "following", "all"]);

/**
 * What an edit changes. A missing field keeps its value; `null` clears a
 * nullable one (`note`, both times for all-day, `repeat` to turn repeat off).
 */
const groupEventChanges = z.object({
  title: z.string().trim().min(1).max(GROUP_EVENT_TITLE_MAX).optional(),
  note: z
    .string()
    .trim()
    .max(GROUP_EVENT_NOTE_MAX)
    .nullable()
    .optional()
    .transform((value) => (value === undefined ? undefined : value || null)),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  startTime: clockTime.nullable().optional(),
  endTime: clockTime.nullable().optional(),
  repeat: repeatRuleInput
    .nullable()
    .optional()
    .transform((rule) => (rule ? normalizeRepeat(rule) : rule)),
});

/** A missing field keeps its value. */
export type GroupEventChanges = { [K in keyof GroupEventShape]?: GroupEventShape[K] };

const orNoChanges = (changes: GroupEventChanges | undefined): GroupEventChanges => changes ?? {};

const editRequest = {
  scope: groupEventScope.optional(),
  occurrenceDate: isoDate.optional(),
};

/** Body of `PATCH /api/group-events/:id`. */
export const validatePatchGroupEvent = z
  .object({ ...editRequest, changes: groupEventChanges.optional() })
  .transform((data) => ({ ...data, changes: orNoChanges(data.changes) }));

export type GroupEventEditRequest = z.infer<typeof validatePatchGroupEvent>;

/** Query of `GET /api/group-events/:id/impact`: a PATCH body, `changes` as a JSON string. */
export const validateGroupEventImpactQuery = z
  .object({
    ...editRequest,
    changes: z
      .string()
      .optional()
      .transform((raw, ctx) => {
        if (raw === undefined || raw === "") return undefined;
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          ctx.addIssue({ code: "custom", message: "`changes` must be a JSON object" });
          return z.NEVER;
        }
      })
      .pipe(groupEventChanges.optional()),
  })
  .transform((data) => ({ ...data, changes: orNoChanges(data.changes) }));

/** Query of `DELETE /api/group-events/:id`. */
export const validateDeleteGroupEventQuery = z.object(editRequest);

export type GroupEventDeleteRequest = z.infer<typeof validateDeleteGroupEventQuery>;

export const validateGroupEventId = z.uuid();

/** Answer of `PATCH` and `DELETE /api/group-events/:id`. */
export type GroupEventWriteResult = {
  droppedOneOffs: number;
  /** Every live row the request wrote, edited or created. */
  events: GroupEventView[];
  /** Rows the request turned into tombstones. */
  deletedIds: string[];
};

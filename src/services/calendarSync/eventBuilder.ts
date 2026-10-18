import { createHash } from "node:crypto";
import {
  calendarCapability,
  calendarProvider,
  calendarSyncEventKind,
} from "../../db/schema/calendar-connection-schema.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { recurrenceLines, rruleLine } from "../../utils/ics.js";
import { weekdayOf } from "../groupEvent/occurrences.js";
import type { RecordTypeLabels } from "../recordType/recordTypeLabels.js";
import { graphBirthdaySeries } from "./birthdaySeries.js";
import { groupEventDescription, groupEventIcs } from "./groupEventShape.js";
import { birthdaySourceKey, groupEventSourceKey } from "./sourceKey.js";
import type { BirthdayFeedRecord, GroupEventFeedRecord, VacationFeedRecord } from "./types.js";

const FOOTER = "Synced from Flexi Day";

type GoogleWhen = { date: string } | { dateTime: string; timeZone: string };

export type GoogleEventPayload = {
  eventType: "workingLocation" | "outOfOffice" | "default";
  summary: string;
  description?: string;
  start: GoogleWhen;
  end: GoogleWhen;
  transparency: "transparent" | "opaque";
  visibility?: "public";
  workingLocationProperties?:
    | { type: "homeOffice"; homeOffice: Record<string, never> }
    | { type: "customLocation"; customLocation: { label: string } };
  outOfOfficeProperties?: { autoDeclineMode: "declineNone" };
  reminders?: { useDefault: false };
  recurrence?: string[];
  /** Vacations keep `flexiDayVacationId`, so their payloads and hashes never moved. */
  extendedProperties: {
    private:
      | { flexiDayVacationId: string; flexiDayConfigId: string }
      | { flexiDaySourceKey: string; flexiDayConfigId: string };
  };
};

type GraphWhen = { dateTime: string; timeZone: string };

type GraphDay = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

type GraphPattern =
  | { type: "daily"; interval: number }
  | { type: "weekly"; interval: number; daysOfWeek: GraphDay[]; firstDayOfWeek: "monday" }
  | { type: "absoluteMonthly"; interval: number; dayOfMonth: number }
  | {
      type: "relativeMonthly";
      interval: number;
      daysOfWeek: GraphDay[];
      index: "first" | "second" | "third" | "fourth" | "last";
    }
  | { type: "absoluteYearly"; interval: number; month: number; dayOfMonth: number };

type GraphRecurrence = {
  pattern: GraphPattern;
  range:
    { type: "noEnd"; startDate: string } | { type: "endDate"; startDate: string; endDate: string };
};

export type MicrosoftEventPayload = {
  subject: string;
  body: { contentType: "text"; content: string };
  start: GraphWhen;
  end: GraphWhen;
  isAllDay: boolean;
  showAs: "oof" | "free";
  isReminderOn: false;
  transactionId: string;
  recurrence?: GraphRecurrence;
};

type Desired<P extends calendarProvider, Payload> = {
  provider: P;
  kind: calendarSyncEventKind;
  payload: Payload;
  contentHash: string;
  /**
   * Graph only: the skipped dates of a recurring group event, cancelled one by
   * one after the series goes in, since Graph takes no exception dates.
   */
  cancelledDates?: string[];
};

export type DesiredEvent =
  | Desired<calendarProvider.Google, GoogleEventPayload>
  | Desired<calendarProvider.Microsoft, MicrosoftEventPayload>;

export type BuildInput = {
  record: Pick<
    VacationFeedRecord,
    "id" | "vacationType" | "requestedDay" | "startTime" | "endTime" | "note"
  >;
  provider: calendarProvider;
  capability: calendarCapability;
  /** IANA name, passed to both providers as is. */
  timeZone: string;
  labels: RecordTypeLabels;
  configId: string;
  /** The ledger row the event belongs to; Microsoft's `transactionId`. */
  ledgerId: string;
};

type Span =
  | { allDay: true; day: string; nextDay: string }
  | { allDay: false; day: string; start: string; end: string };

const nextDay = (day: string): string => {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
};

const clock = (time: string): string => (time.length === 5 ? `${time}:00` : time);

const spanOf = (record: BuildInput["record"]): Span => {
  const day = record.requestedDay;
  if (!record.startTime || !record.endTime) return { allDay: true, day, nextDay: nextDay(day) };
  const start = `${day}T${clock(record.startTime)}`;
  const end = clock(record.endTime);
  // A row is one day; an end at or before its start (a night shift) is cut at midnight.
  return {
    allDay: false,
    day,
    start,
    end: end > clock(record.startTime) ? `${day}T${end}` : `${nextDay(day)}T00:00:00`,
  };
};

const description = (note: string | null): string => {
  const trimmed = note?.trim();
  return trimmed ? `${trimmed}\n${FOOTER}` : FOOTER;
};

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)])
    );
  }
  return value;
};

const hashOf = (kind: calendarSyncEventKind, payload: object): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical({ kind, payload })))
    .digest("hex");

const googlePayload = (
  input: BuildInput,
  span: Span,
  homeOffice: boolean
): GoogleEventPayload | null => {
  const label = input.labels[input.record.vacationType];
  const extendedProperties = {
    private: { flexiDayVacationId: input.record.id, flexiDayConfigId: input.configId },
  };
  const allDay = { start: { date: span.day }, end: { date: nextDay(span.day) } };
  const statusTypes = input.capability !== calendarCapability.Plain;

  if (homeOffice || (statusTypes && span.allDay)) {
    if (!statusTypes) return null;
    return {
      eventType: "workingLocation",
      summary: label,
      ...allDay,
      transparency: "transparent",
      visibility: "public",
      workingLocationProperties: homeOffice
        ? { type: "homeOffice", homeOffice: {} }
        : { type: "customLocation", customLocation: { label } },
      extendedProperties,
    };
  }

  const when = span.allDay
    ? allDay
    : {
        start: { dateTime: span.start, timeZone: input.timeZone },
        end: { dateTime: span.end, timeZone: input.timeZone },
      };
  return statusTypes
    ? {
        eventType: "outOfOffice",
        summary: label,
        description: description(input.record.note),
        ...when,
        transparency: "opaque",
        outOfOfficeProperties: { autoDeclineMode: "declineNone" },
        extendedProperties,
      }
    : {
        eventType: "default",
        summary: label,
        description: description(input.record.note),
        ...when,
        transparency: "opaque",
        reminders: { useDefault: false },
        extendedProperties,
      };
};

const microsoftPayload = (input: BuildInput, span: Span): MicrosoftEventPayload => {
  const zone = input.timeZone;
  return {
    subject: input.labels[input.record.vacationType],
    body: { contentType: "text", content: description(input.record.note) },
    start: { dateTime: span.allDay ? `${span.day}T00:00:00` : span.start, timeZone: zone },
    end: { dateTime: span.allDay ? `${span.nextDay}T00:00:00` : span.end, timeZone: zone },
    isAllDay: span.allDay,
    showAs: "oof",
    isReminderOn: false,
    transactionId: input.ledgerId,
  };
};

/**
 * The provider event one approved day row should be, or `null` when the
 * provider has nothing to show for it (Home office outside Google's status
 * types). `UNKNOWN` capability builds the status shape for the first attempt.
 */
export const buildDesired = (input: BuildInput): DesiredEvent | null => {
  const homeOffice = input.record.vacationType === CalendarRecordType.HomeOffice;
  const kind = homeOffice ? calendarSyncEventKind.HomeOffice : calendarSyncEventKind.Absence;
  const span = spanOf(input.record);

  if (input.provider === calendarProvider.Google) {
    const payload = googlePayload(input, span, homeOffice);
    if (!payload) return null;
    return { provider: input.provider, kind, payload, contentHash: hashOf(kind, payload) };
  }

  if (homeOffice) return null;
  const payload = microsoftPayload(input, span);
  const { transactionId: _immutable, ...content } = payload;
  return { provider: input.provider, kind, payload, contentHash: hashOf(kind, content) };
};

export type BirthdayBuildInput = {
  record: BirthdayFeedRecord;
  /** Which of `graphBirthdaySeries` this event is; null for the only one. */
  segment: number | null;
  provider: calendarProvider;
  timeZone: string;
  /** "Birthday" in the owner's language. */
  title: string;
  configId: string;
  ledgerId: string;
};

/** A birthday on a sync target: a free all-day yearly series, the same on every capability. */
export const buildBirthdayDesired = (input: BirthdayBuildInput): DesiredEvent => {
  const kind = calendarSyncEventKind.Birthday;
  const { record } = input;

  if (input.provider === calendarProvider.Google) {
    const repeat = {
      freq: "yearly" as const,
      interval: 1,
      until: null,
      yearlyOn: { month: record.month, day: record.day },
    };
    const payload: GoogleEventPayload = {
      eventType: "default",
      summary: input.title,
      description: FOOTER,
      start: { date: record.startDate },
      end: { date: nextDay(record.startDate) },
      transparency: "transparent",
      reminders: { useDefault: false },
      recurrence: [rruleLine(repeat, record.startDate, null)],
      extendedProperties: {
        private: {
          flexiDaySourceKey: birthdaySourceKey(record.userId, input.segment),
          flexiDayConfigId: input.configId,
        },
      },
    };
    return { provider: input.provider, kind, payload, contentHash: hashOf(kind, payload) };
  }

  const series =
    graphBirthdaySeries(record).find((s) => s.segment === input.segment) ??
    graphBirthdaySeries(record)[0]!;
  const zone = input.timeZone;
  const payload: MicrosoftEventPayload = {
    subject: input.title,
    body: { contentType: "text", content: FOOTER },
    start: { dateTime: `${series.startDate}T00:00:00`, timeZone: zone },
    end: { dateTime: `${nextDay(series.startDate)}T00:00:00`, timeZone: zone },
    isAllDay: true,
    showAs: "free",
    isReminderOn: false,
    transactionId: input.ledgerId,
    recurrence: {
      pattern: {
        type: "absoluteYearly",
        interval: series.interval,
        month: series.month,
        dayOfMonth: series.dayOfMonth,
      },
      range: { type: "noEnd", startDate: series.startDate },
    },
  };
  const { transactionId: _immutable, ...content } = payload;
  return { provider: input.provider, kind, payload, contentHash: hashOf(kind, content) };
};

/**
 * The zone Graph gets for a group event. IANA names pass as they are; the
 * T-348 probe has not shown whether Graph takes one on a recurring event.
 * Should it refuse, map to the Windows name here and nowhere else.
 */
export const graphTimeZone = (zone: string): string => zone;

export type GroupEventBuildInput = {
  record: GroupEventFeedRecord;
  provider: calendarProvider;
  /** The target's IANA zone, stamped on the event's floating times. */
  timeZone: string;
  /** The line naming the group, in the owner's language. */
  groupLine: string;
  configId: string;
  ledgerId: string;
};

const GRAPH_DAYS: GraphDay[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

const GRAPH_INDEX = ["first", "second", "third", "fourth"] as const;

const graphRecurrence = (record: GroupEventFeedRecord): GraphRecurrence | undefined => {
  const rule = record.repeat;
  if (!rule) return undefined;
  const start = record.startDate;
  const day = Number(start.slice(8, 10));
  const interval = rule.interval;
  const weekday = GRAPH_DAYS[weekdayOf(start)]!;

  let pattern: GraphPattern;
  if (rule.freq === "daily") {
    pattern = { type: "daily", interval };
  } else if (rule.freq === "weekly") {
    const days = new Set([...rule.weekdays, weekdayOf(start)]);
    pattern = {
      type: "weekly",
      interval,
      daysOfWeek: GRAPH_DAYS.filter((_, i) => days.has(i)),
      firstDayOfWeek: "monday",
    };
  } else if (rule.freq === "monthly") {
    const nth = Math.ceil(day / 7);
    if (rule.monthlyMode === "weekday" || rule.monthlyMode === "lastWeekday") {
      // A start on a 5th weekday can only repeat on the last one.
      const index = rule.monthlyMode === "lastWeekday" || nth > 4 ? "last" : GRAPH_INDEX[nth - 1]!;
      pattern = { type: "relativeMonthly", interval, daysOfWeek: [weekday], index };
    } else {
      // Graph lands a day the month lacks on its last day, as the app does.
      pattern = { type: "absoluteMonthly", interval, dayOfMonth: day };
    }
  } else {
    pattern = {
      type: "absoluteYearly",
      interval,
      month: Number(start.slice(5, 7)),
      dayOfMonth: day,
    };
  }

  return {
    pattern,
    range: rule.until
      ? { type: "endDate", startDate: start, endDate: rule.until }
      : { type: "noEnd", startDate: start },
  };
};

/**
 * A group event on a sync target: a plain `default` event, always free,
 * never Out of office or a working location, on every capability. Timed ones
 * carry the target's zone; recurring ones go out as one series.
 */
export const buildGroupEventDesired = (input: GroupEventBuildInput): DesiredEvent => {
  const kind = calendarSyncEventKind.GroupEvent;
  const { record } = input;
  const text = `${groupEventDescription(record, input.groupLine)}\n${FOOTER}`;
  const timed = record.startTime !== null && record.endTime !== null;

  if (input.provider === calendarProvider.Google) {
    const when: Pick<GoogleEventPayload, "start" | "end"> = timed
      ? {
          start: {
            dateTime: `${record.startDate}T${clock(record.startTime!)}`,
            timeZone: input.timeZone,
          },
          end: {
            dateTime: `${record.endDate}T${clock(record.endTime!)}`,
            timeZone: input.timeZone,
          },
        }
      : { start: { date: record.startDate }, end: { date: nextDay(record.endDate) } };
    const recurrence = recurrenceLines(
      groupEventIcs(record, { uid: record.id, summary: record.title }, input.timeZone)
    );
    const payload: GoogleEventPayload = {
      eventType: "default",
      summary: record.title,
      description: text,
      ...when,
      transparency: "transparent",
      reminders: { useDefault: false },
      ...(recurrence.length > 0 ? { recurrence } : {}),
      extendedProperties: {
        private: {
          flexiDaySourceKey: groupEventSourceKey(record.id),
          flexiDayConfigId: input.configId,
        },
      },
    };
    return { provider: input.provider, kind, payload, contentHash: hashOf(kind, payload) };
  }

  const zone = graphTimeZone(input.timeZone);
  const recurrence = graphRecurrence(record);
  const payload: MicrosoftEventPayload = {
    subject: record.title,
    body: { contentType: "text", content: text },
    start: {
      dateTime: timed
        ? `${record.startDate}T${clock(record.startTime!)}`
        : `${record.startDate}T00:00:00`,
      timeZone: zone,
    },
    end: {
      dateTime: timed
        ? `${record.endDate}T${clock(record.endTime!)}`
        : `${nextDay(record.endDate)}T00:00:00`,
      timeZone: zone,
    },
    isAllDay: !timed,
    showAs: "free",
    isReminderOn: false,
    transactionId: input.ledgerId,
    ...(recurrence ? { recurrence } : {}),
  };
  const { transactionId: _immutable, ...content } = payload;
  if (!recurrence)
    return { provider: input.provider, kind, payload, contentHash: hashOf(kind, content) };

  const cancelledDates = [...record.skippedDates].sort();
  const { start, end, isAllDay } = payload;
  const shape = hashOf(kind, { start, end, isAllDay, recurrence, cancelledDates });
  return {
    provider: input.provider,
    kind,
    payload,
    contentHash: `${shape}${SERIES_SHAPE_SEPARATOR}${hashOf(kind, { ...content, cancelledDates })}`,
    cancelledDates,
  };
};

const SERIES_SHAPE_SEPARATOR = ":";

/**
 * The part of a Graph series' content hash covering its start, end, rule and
 * skipped dates, or null for any other event. The engine replaces a series
 * when this part changes and patches it otherwise.
 */
export const seriesShapeOf = (contentHash: string | null): string | null => {
  const at = contentHash?.indexOf(SERIES_SHAPE_SEPARATOR) ?? -1;
  return at === -1 ? null : contentHash!.slice(0, at);
};

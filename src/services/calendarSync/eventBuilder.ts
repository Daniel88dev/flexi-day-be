import { createHash } from "node:crypto";
import {
  calendarCapability,
  calendarProvider,
  calendarSyncEventKind,
} from "../../db/schema/calendar-connection-schema.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import type { RecordTypeLabels } from "./labels.js";
import type { CalendarFeedRecord } from "./types.js";

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
  extendedProperties: { private: { flexiDayVacationId: string; flexiDayConfigId: string } };
};

type GraphWhen = { dateTime: string; timeZone: string };

export type MicrosoftEventPayload = {
  subject: string;
  body: { contentType: "text"; content: string };
  start: GraphWhen;
  end: GraphWhen;
  isAllDay: boolean;
  showAs: "oof";
  isReminderOn: false;
  transactionId: string;
};

type Desired<P extends calendarProvider, Payload> = {
  provider: P;
  kind: calendarSyncEventKind;
  payload: Payload;
  contentHash: string;
};

export type DesiredEvent =
  | Desired<calendarProvider.Google, GoogleEventPayload>
  | Desired<calendarProvider.Microsoft, MicrosoftEventPayload>;

export type BuildInput = {
  record: Pick<
    CalendarFeedRecord,
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

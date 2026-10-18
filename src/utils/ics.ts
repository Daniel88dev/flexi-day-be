/**
 * Minimal iCalendar (RFC 5545) serializer for read-only feeds: all-day time
 * off, plus timed and recurring events with their `VTIMEZONE` blocks. Only the
 * subset of the spec that calendar clients, Outlook's import included, read
 * from a subscribed feed is implemented.
 */
import { logger } from "../middleware/logger.js";

/** A repeat rule read off the event's start date (spec D5). */
export type IcsRepeat = {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  weekdays?: number[];
  monthlyMode?: "day" | "weekday" | "lastWeekday";
  until: string | null;
};

type IcsEventBase = {
  /** Globally-unique, stable id for the event (RFC 5545 UID). */
  uid: string;
  summary: string;
  description?: string;
  /** Free-form categories (e.g. the leave-type label). */
  categories?: string[];
  repeat?: IcsRepeat;
  skippedDates?: string[];
};

export type IcsAllDayEvent = IcsEventBase & {
  kind?: "allDay";
  /** Inclusive first day, `YYYY-MM-DD`. */
  startDate: string;
  /** Inclusive last day, `YYYY-MM-DD`. Defaults to `startDate`. */
  endDate?: string;
};

/** Floating wall-clock times, stamped with `timeZone` on output. */
export type IcsTimedEvent = IcsEventBase & {
  kind: "timed";
  timeZone: string;
  startDate: string;
  startTime: string;
  endDate?: string;
  endTime: string;
};

export type IcsEvent = IcsAllDayEvent | IcsTimedEvent;

export type IcsCalendar = {
  name: string;
  /** iCalendar PRODID owner string. */
  prodId?: string;
  events: IcsEvent[];
};

/** Escapes a value per RFC 5545 §3.3.11 (TEXT). */
const escapeText = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

const encoder = new TextEncoder();

/**
 * Splits off a prefix of `s` whose UTF-8 encoding is at most `limit` octets,
 * never breaking a Unicode code point (so surrogate pairs stay intact).
 * Returns `[chunk, rest]`.
 */
const takeOctets = (s: string, limit: number): [string, string] => {
  let end = 0;
  let bytes = 0;
  for (const char of s) {
    const charBytes = encoder.encode(char).length;
    if (bytes + charBytes > limit) break;
    bytes += charBytes;
    end += char.length;
  }
  return [s.slice(0, end), s.slice(end)];
};

/**
 * Folds a content line to <=75 octets with CRLF + space continuation. Folding
 * is measured in UTF-8 octets per RFC 5545 §3.1 (not JS string length), so
 * multi-byte characters are counted correctly and never split mid code point.
 */
const foldLine = (line: string): string => {
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let [chunk, remaining] = takeOctets(line, 75);
  parts.push(chunk);
  // Continuation lines start with a space, leaving 74 octets of content.
  while (encoder.encode(remaining).length > 74) {
    [chunk, remaining] = takeOctets(remaining, 74);
    parts.push(" " + chunk);
  }
  if (remaining.length > 0) parts.push(" " + remaining);
  return parts.join("\r\n");
};

/** `YYYY-MM-DD` -> `YYYYMMDD` (DATE value type). */
const toDateValue = (isoDate: string): string => isoDate.replace(/-/g, "");

/** `YYYY-MM-DD` -> `YYYYMMDD` for the day after (DTEND is exclusive). */
const nextDayValue = (isoDate: string): string => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return toDateValue(d.toISOString().slice(0, 10));
};

/** UTC timestamp in iCalendar form, e.g. `20260711T120000Z`. */
const toTimestamp = (date: Date): string =>
  date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

const MINUTE = 60_000;
const DAY = 86_400_000;

type Ymd = { year: number; month: number; day: number };

const parseDate = (isoDate: string): Ymd => {
  const [year = NaN, month = NaN, day = NaN] = isoDate.split("-").map(Number);
  return { year, month, day };
};

const parseTime = (time: string) => {
  const [hour = NaN, minute = NaN, second = 0] = time.split(":").map(Number);
  return { hour, minute, second };
};

const weekdayOf = ({ year, month, day }: Ymd) =>
  (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;

const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

const nthWeekdayDay = (year: number, month: number, weekday: number, n: number) => {
  if (n === -1) {
    const last = daysInMonth(year, month);
    return last - ((weekdayOf({ year, month, day: last }) - weekday + 7) % 7);
  }
  const first = weekdayOf({ year, month, day: 1 });
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
};

const localDateTime = (isoDate: string, time: string) => {
  const { hour, minute, second } = parseTime(time);
  return `${toDateValue(isoDate)}T${pad(hour)}${pad(minute)}${pad(second)}`;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

const offsetMinutes = (timeZone: string, instant: number): number => {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  const at = Math.floor(instant / 1000) * 1000;
  const parts = formatter.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second")
  );
  return Math.round((wall - at) / MINUTE);
};

const wallClockToUtc = (timeZone: string, isoDate: string, time: string): Date => {
  const { year, month, day } = parseDate(isoDate);
  const { hour, minute, second } = parseTime(time);
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const guess = wall - offsetMinutes(timeZone, wall) * MINUTE;
  return new Date(wall - offsetMinutes(timeZone, guess) * MINUTE);
};

const formatOffset = (minutes: number) => {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
};

type Transition = { from: number; to: number; wall: Date };

const transitionsIn = (timeZone: string, year: number): Transition[] => {
  const out: Transition[] = [];
  const end = Date.UTC(year + 1, 0, 1);
  let at = Date.UTC(year, 0, 1);
  let current = offsetMinutes(timeZone, at);
  while (at < end) {
    const next = Math.min(at + DAY, end);
    const nextOffset = offsetMinutes(timeZone, next);
    if (nextOffset !== current) {
      let lo = at;
      let hi = next;
      while (hi - lo > MINUTE) {
        const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
        if (offsetMinutes(timeZone, mid) === current) lo = mid;
        else hi = mid;
      }
      const to = offsetMinutes(timeZone, hi);
      out.push({ from: current, to, wall: new Date(hi + current * MINUTE) });
      current = to;
    }
    at = next;
  }
  return out;
};

type YearlyRule = { month: number; weekday: number; n: number; time: string };

const wallTime = (wall: Date) =>
  `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}`;

const candidateRules = ({ wall }: Transition): YearlyRule[] => {
  const year = wall.getUTCFullYear();
  const month = wall.getUTCMonth() + 1;
  const day = wall.getUTCDate();
  const weekday = weekdayOf({ year, month, day });
  const time = wallTime(wall);
  const rules: YearlyRule[] = [];
  if (day + 7 > daysInMonth(year, month)) rules.push({ month, weekday, n: -1, time });
  const n = Math.ceil(day / 7);
  if (n <= 4) rules.push({ month, weekday, n, time });
  return rules;
};

const ruleMatches = (rule: YearlyRule, transition: Transition | undefined) => {
  if (!transition) return false;
  const { wall } = transition;
  const year = wall.getUTCFullYear();
  return (
    wall.getUTCMonth() + 1 === rule.month &&
    wall.getUTCDate() === nthWeekdayDay(year, rule.month, rule.weekday, rule.n) &&
    wallTime(wall) === rule.time
  );
};

/** Years past the current one a weekday rule must also predict before it is trusted. */
const RULE_CHECK_YEARS = 2;

const ruleLines = (name: "STANDARD" | "DAYLIGHT", transition: Transition, rule: YearlyRule) => {
  const day = nthWeekdayDay(1970, rule.month, rule.weekday, rule.n);
  const start = `1970-${pad(rule.month)}-${pad(day)}`;
  return [
    `BEGIN:${name}`,
    `DTSTART:${localDateTime(start, rule.time)}`,
    `TZOFFSETFROM:${formatOffset(transition.from)}`,
    `TZOFFSETTO:${formatOffset(transition.to)}`,
    `RRULE:FREQ=YEARLY;BYMONTH=${rule.month};BYDAY=${rule.n}${WEEKDAY_CODES[rule.weekday]}`,
    `END:${name}`,
  ];
};

const weekdayRuleObservances = (
  timeZone: string,
  year: number,
  transitions: Transition[]
): string[] | null => {
  const daylight = transitions.find((t) => t.to > t.from);
  const standard = transitions.find((t) => t.to < t.from);
  if (transitions.length !== 2 || !daylight || !standard) return null;

  const later = Array.from({ length: RULE_CHECK_YEARS }, (_, i) =>
    transitionsIn(timeZone, year + 1 + i)
  );
  const fit = (transition: Transition) => {
    const sameKind = (t: Transition) => t.from === transition.from && t.to === transition.to;
    return candidateRules(transition).find((rule) =>
      later.every((ts) => ruleMatches(rule, ts.find(sameKind)))
    );
  };
  const daylightRule = fit(daylight);
  const standardRule = fit(standard);
  if (!daylightRule || !standardRule) return null;
  return [
    ...ruleLines("DAYLIGHT", daylight, daylightRule),
    ...ruleLines("STANDARD", standard, standardRule),
  ];
};

const vtimezoneCache = new Map<string, string[]>();

/**
 * A `VTIMEZONE` derived from the zone's offsets in `year` (spec S10): one
 * `STANDARD` and one `DAYLIGHT` with yearly weekday rules, which is the shape
 * Outlook reads, or a single `STANDARD` for a zone without daylight saving.
 * Transitions no weekday rule predicts fall back to that year's fixed dates.
 */
const vtimezoneLines = (timeZone: string, year: number): string[] => {
  const key = `${timeZone}|${year}`;
  const cached = vtimezoneCache.get(key);
  if (cached) return cached;

  const transitions = transitionsIn(timeZone, year);
  let observances: string[];
  if (transitions.length === 0) {
    const offset = formatOffset(offsetMinutes(timeZone, Date.UTC(year, 0, 1)));
    observances = [
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      `TZOFFSETFROM:${offset}`,
      `TZOFFSETTO:${offset}`,
      "END:STANDARD",
    ];
  } else {
    const ruled = weekdayRuleObservances(timeZone, year, transitions);
    if (ruled) {
      observances = ruled;
    } else {
      logger.warn("ics.vtimezone.fixed_offsets", { timeZone, year });
      observances = transitions.flatMap((transition) => {
        const name = transition.to > transition.from ? "DAYLIGHT" : "STANDARD";
        const { wall } = transition;
        return [
          `BEGIN:${name}`,
          `DTSTART:${localDateTime(wall.toISOString().slice(0, 10), wallTime(wall))}`,
          `TZOFFSETFROM:${formatOffset(transition.from)}`,
          `TZOFFSETTO:${formatOffset(transition.to)}`,
          `END:${name}`,
        ];
      });
    }
  }

  const lines = ["BEGIN:VTIMEZONE", `TZID:${timeZone}`, ...observances, "END:VTIMEZONE"];
  vtimezoneCache.set(key, lines);
  return lines;
};

/**
 * The `RRULE` part for "monthly on day N" (spec D11). Days past 28 must land
 * on the month's last day when the month is short, as Outlook and Graph do.
 * Days 29 and 30 use the `BYSETPOS` form pending the provider probe (T-348);
 * its fallback is "day 1 to 28" plus an explicit last day, a change to this
 * function alone.
 */
export const monthlyDayRule = (day: number): string => {
  if (day <= 28) return `BYMONTHDAY=${day}`;
  if (day === 31) return "BYMONTHDAY=-1";
  const days = Array.from({ length: day - 27 }, (_, i) => 28 + i);
  return `BYMONTHDAY=${days.join(",")};BYSETPOS=-1`;
};

const rruleLine = (repeat: IcsRepeat, startDate: string, until: string | null): string => {
  const start = parseDate(startDate);
  const parts = [`FREQ=${repeat.freq.toUpperCase()}`];
  if (repeat.interval > 1) parts.push(`INTERVAL=${repeat.interval}`);

  if (repeat.freq === "weekly") {
    const days = new Set([...(repeat.weekdays ?? []), weekdayOf(start)]);
    const codes = WEEKDAY_CODES.filter((_, i) => days.has(i));
    parts.push(`BYDAY=${codes.join(",")}`);
  } else if (repeat.freq === "monthly") {
    const code = WEEKDAY_CODES[weekdayOf(start)];
    const mode = repeat.monthlyMode ?? "day";
    if (mode === "day") parts.push(monthlyDayRule(start.day));
    else if (mode === "lastWeekday") parts.push(`BYDAY=-1${code}`);
    else {
      // A 5th weekday offers only "last" (D5).
      const n = Math.ceil(start.day / 7);
      parts.push(`BYDAY=${n > 4 ? -1 : n}${code}`);
    }
  } else if (repeat.freq === "yearly" && start.month === 2 && start.day === 29) {
    parts.push("BYMONTH=2;BYMONTHDAY=-1");
  }

  if (until) parts.push(`UNTIL=${until}`);
  return `RRULE:${parts.join(";")}`;
};

const eventLines = (event: IcsEvent, now: string): string[] => {
  const lines = [`UID:${escapeText(event.uid)}`, `DTSTAMP:${now}`];

  if (event.kind === "timed") {
    const zone = `TZID=${event.timeZone}`;
    lines.push(
      `DTSTART;${zone}:${localDateTime(event.startDate, event.startTime)}`,
      `DTEND;${zone}:${localDateTime(event.endDate ?? event.startDate, event.endTime)}`
    );
    if (event.repeat) {
      const until = event.repeat.until
        ? toTimestamp(wallClockToUtc(event.timeZone, event.repeat.until, event.startTime))
        : null;
      lines.push(rruleLine(event.repeat, event.startDate, until));
      for (const date of event.skippedDates ?? []) {
        lines.push(`EXDATE;${zone}:${localDateTime(date, event.startTime)}`);
      }
    }
  } else {
    lines.push(
      `DTSTART;VALUE=DATE:${toDateValue(event.startDate)}`,
      `DTEND;VALUE=DATE:${nextDayValue(event.endDate ?? event.startDate)}`
    );
    if (event.repeat) {
      const until = event.repeat.until ? toDateValue(event.repeat.until) : null;
      lines.push(rruleLine(event.repeat, event.startDate, until));
      for (const date of event.skippedDates ?? []) {
        lines.push(`EXDATE;VALUE=DATE:${toDateValue(date)}`);
      }
    }
  }

  lines.push(`SUMMARY:${escapeText(event.summary)}`);
  if (event.description) {
    lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  }
  if (event.categories && event.categories.length > 0) {
    lines.push(`CATEGORIES:${event.categories.map(escapeText).join(",")}`);
  }
  // Every Flexi Day entry is informational, so none blocks the viewer's time.
  lines.push("TRANSP:TRANSPARENT");
  return lines;
};

/**
 * Renders an iCalendar document. All-day events are `VALUE=DATE` with an
 * exclusive DTEND, which is how calendar clients expect multi-day absences to
 * appear. Timed events carry their zone's `TZID`, and each zone in use gets one
 * `VTIMEZONE` ahead of the events.
 */
export const buildIcsCalendar = (calendar: IcsCalendar): string => {
  const nowDate = new Date();
  const now = toTimestamp(nowDate);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${calendar.prodId ?? "Flexi-Day//Calendar Sync"}//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calendar.name)}`,
  ];

  const zones = new Set<string>();
  for (const event of calendar.events) {
    if (event.kind === "timed") zones.add(event.timeZone);
  }
  for (const zone of zones) {
    lines.push(...vtimezoneLines(zone, nowDate.getUTCFullYear()));
  }

  for (const event of calendar.events) {
    lines.push("BEGIN:VEVENT", ...eventLines(event, now), "END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
};

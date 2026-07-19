/**
 * Minimal iCalendar (RFC 5545) serializer for read-only, all-day time-off
 * feeds. Only the subset of the spec that calendar clients need to subscribe
 * to an absence feed is implemented.
 */

export type IcsEvent = {
  /** Globally-unique, stable id for the event (RFC 5545 UID). */
  uid: string;
  /** Inclusive first day, `YYYY-MM-DD`. */
  startDate: string;
  /** Inclusive last day, `YYYY-MM-DD`. Defaults to `startDate`. */
  endDate?: string;
  summary: string;
  description?: string;
  /** Free-form categories (e.g. the leave-type label). */
  categories?: string[];
};

export type IcsCalendar = {
  name: string;
  /** iCalendar PRODID owner string. */
  prodId?: string;
  events: IcsEvent[];
};

/** Escapes a value per RFC 5545 §3.3.11 (TEXT). */
const escapeText = (value: string): string =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");

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
  date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/**
 * Renders an iCalendar document. Events are emitted as all-day (VALUE=DATE)
 * with an exclusive DTEND, which is how calendar clients expect multi-day
 * absences to appear.
 */
export const buildIcsCalendar = (calendar: IcsCalendar): string => {
  const now = toTimestamp(new Date());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${calendar.prodId ?? "Flexi-Day//Calendar Sync"}//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calendar.name)}`,
  ];

  for (const event of calendar.events) {
    const end = event.endDate ?? event.startDate;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeText(event.uid)}`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${toDateValue(event.startDate)}`,
      `DTEND;VALUE=DATE:${nextDayValue(end)}`,
      `SUMMARY:${escapeText(event.summary)}`
    );
    if (event.description) {
      lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    }
    if (event.categories && event.categories.length > 0) {
      lines.push(`CATEGORIES:${event.categories.map(escapeText).join(",")}`);
    }
    lines.push("TRANSP:TRANSPARENT", "END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
};

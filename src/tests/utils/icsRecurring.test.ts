import { buildIcsCalendar, type IcsEvent, type IcsRepeat } from "../../utils/ics";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../middleware/logger.js", () => ({ logger: { warn } }));

const lines = (ics: string) => ics.split("\r\n");

const withoutStamp = (ics: string) => lines(ics).filter((line) => !line.startsWith("DTSTAMP:"));

const block = (ics: string, begin: string, end: string) => {
  const all = withoutStamp(ics);
  return all.slice(all.indexOf(begin), all.lastIndexOf(end) + 1);
};

const rruleOf = (event: IcsEvent) =>
  block(buildIcsCalendar({ name: "Feed", events: [event] }), "BEGIN:VEVENT", "END:VEVENT").find(
    (line) => line.startsWith("RRULE:")
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T21:30:05.123Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildIcsCalendar, all-day output", () => {
  test("today's vacation feed is byte-identical", () => {
    const out = buildIcsCalendar({
      name: "Dana's team; Q4, Praha",
      events: [
        {
          uid: "v1@flexiday",
          startDate: "2026-06-03",
          endDate: "2026-06-05",
          summary: "Dana — Vacation",
          description:
            "Line one\nline two, with; marks \\ and a long tail that keeps going until it has to fold past the limit",
          categories: ["Vacation", "Paid time off"],
        },
        {
          uid: "v2@flexiday",
          startDate: "2026-12-31",
          summary: "Žofie Čermáková — Nemocenská dovolená přes konec roku a ještě něco navíc",
        },
      ],
    });
    // Captured from the writer before timed and recurring events existed.
    expect(out).toBe(
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Flexi-Day//Calendar Sync//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\nX-WR-CALNAME:Dana's team\\; Q4\\, Praha\r\nBEGIN:VEVENT\r\nUID:v1@flexiday\r\nDTSTAMP:20261017T213005Z\r\nDTSTART;VALUE=DATE:20260603\r\nDTEND;VALUE=DATE:20260606\r\nSUMMARY:Dana — Vacation\r\nDESCRIPTION:Line one\\nline two\\, with\\; marks \\\\ and a long tail that keeps\r\n  going until it has to fold past the limit\r\nCATEGORIES:Vacation,Paid time off\r\nTRANSP:TRANSPARENT\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:v2@flexiday\r\nDTSTAMP:20261017T213005Z\r\nDTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101\r\nSUMMARY:Žofie Čermáková — Nemocenská dovolená přes konec roku a je\r\n ště něco navíc\r\nTRANSP:TRANSPARENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    );
  });
});

describe("buildIcsCalendar, timed and recurring events", () => {
  test("a weekly timed series in Europe/Prague and a 29 February birthday match the research encoding", () => {
    const out = buildIcsCalendar({
      name: "Feed",
      events: [
        {
          kind: "timed",
          uid: "ge-<groupEventId>@flexiday",
          timeZone: "Europe/Prague",
          startDate: "2026-10-20",
          startTime: "09:00",
          endTime: "10:00",
          repeat: { freq: "weekly", interval: 1, weekdays: [1], until: "2027-06-29" },
          skippedDates: ["2026-12-22"],
          summary: "Team retro",
        },
        {
          uid: "bd-<userId>@flexiday",
          startDate: "2028-02-29",
          repeat: { freq: "yearly", interval: 1, until: null },
          summary: "Anna's birthday",
        },
      ],
    });

    // Research doc recurring-events-encoding.md, section 4, "ICS feed".
    expect(block(out, "BEGIN:VTIMEZONE", "END:VEVENT")).toEqual([
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Prague",
      "BEGIN:DAYLIGHT",
      "DTSTART:19700329T020000",
      "TZOFFSETFROM:+0100",
      "TZOFFSETTO:+0200",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
      "END:DAYLIGHT",
      "BEGIN:STANDARD",
      "DTSTART:19701025T030000",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
      "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:ge-<groupEventId>@flexiday",
      "DTSTART;TZID=Europe/Prague:20261020T090000",
      "DTEND;TZID=Europe/Prague:20261020T100000",
      "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20270629T070000Z",
      "EXDATE;TZID=Europe/Prague:20261222T090000",
      "SUMMARY:Team retro",
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:bd-<userId>@flexiday",
      "DTSTART;VALUE=DATE:20280229",
      "DTEND;VALUE=DATE:20280301",
      "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1",
      "SUMMARY:Anna's birthday",
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    ]);
    expect(lines(out).filter((line) => line === "DTSTAMP:20261017T213005Z")).toHaveLength(2);
  });

  test("Asia/Tokyo emits a VTIMEZONE with a single STANDARD", () => {
    const out = buildIcsCalendar({ name: "Feed", events: [timedIn("Asia/Tokyo")] });
    expect(block(out, "BEGIN:VTIMEZONE", "END:VTIMEZONE")).toEqual([
      "BEGIN:VTIMEZONE",
      "TZID:Asia/Tokyo",
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:+0900",
      "TZOFFSETTO:+0900",
      "END:STANDARD",
      "END:VTIMEZONE",
    ]);
  });
});

const timedIn = (timeZone: string, repeat?: IcsRepeat): IcsEvent => ({
  kind: "timed",
  uid: `ge-${timeZone}@flexiday`,
  timeZone,
  startDate: "2026-10-20",
  startTime: "09:00",
  endTime: "10:00",
  repeat,
  summary: "Standup",
});

const allDay = (startDate: string, repeat: IcsRepeat, skippedDates?: string[]): IcsEvent => ({
  uid: `ge-${startDate}@flexiday`,
  startDate,
  repeat,
  skippedDates,
  summary: "Team day",
});

const forever = { interval: 1, until: null } as const;

describe("buildIcsCalendar, repeat rules (D5, D11)", () => {
  test("an all-day yearly series on 29 February lands on the last day of February", () => {
    expect(rruleOf(allDay("2028-02-29", { freq: "yearly", ...forever }))).toBe(
      "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1"
    );
  });

  test("a yearly series on any other date repeats on its start date", () => {
    expect(rruleOf(allDay("2026-10-20", { freq: "yearly", interval: 2, until: null }))).toBe(
      "RRULE:FREQ=YEARLY;INTERVAL=2"
    );
  });

  test("monthly on day 31 is the last day of the month", () => {
    expect(rruleOf(allDay("2027-01-31", { freq: "monthly", monthlyMode: "day", ...forever }))).toBe(
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=-1"
    );
  });

  test("monthly on day 30 takes the last of days 28 to 30", () => {
    expect(rruleOf(allDay("2028-01-30", { freq: "monthly", monthlyMode: "day", ...forever }))).toBe(
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30;BYSETPOS=-1"
    );
  });

  test("monthly on day 29 takes the last of days 28 and 29", () => {
    expect(rruleOf(allDay("2027-01-29", { freq: "monthly", monthlyMode: "day", ...forever }))).toBe(
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29;BYSETPOS=-1"
    );
  });

  test("monthly on day 28 or earlier is that day", () => {
    expect(rruleOf(allDay("2026-10-28", { freq: "monthly", ...forever }))).toBe(
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=28"
    );
    expect(rruleOf(allDay("2026-10-05", { freq: "monthly", interval: 3, until: null }))).toBe(
      "RRULE:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=5"
    );
  });

  test("monthly on the last Friday", () => {
    expect(
      rruleOf(allDay("2026-10-30", { freq: "monthly", monthlyMode: "lastWeekday", ...forever }))
    ).toBe("RRULE:FREQ=MONTHLY;BYDAY=-1FR");
  });

  test("monthly on the 2nd Tuesday", () => {
    expect(
      rruleOf(allDay("2026-10-13", { freq: "monthly", monthlyMode: "weekday", ...forever }))
    ).toBe("RRULE:FREQ=MONTHLY;BYDAY=2TU");
  });

  test("monthly on a 5th weekday falls to the last one", () => {
    expect(
      rruleOf(allDay("2026-10-30", { freq: "monthly", monthlyMode: "weekday", ...forever }))
    ).toBe("RRULE:FREQ=MONTHLY;BYDAY=-1FR");
  });

  test("weekly on several days lists them Monday first and always holds the start's weekday", () => {
    expect(
      rruleOf(allDay("2026-10-07", { freq: "weekly", interval: 2, weekdays: [4, 0], until: null }))
    ).toBe("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR");
  });

  test("daily every 99 days", () => {
    expect(rruleOf(allDay("2026-10-01", { freq: "daily", interval: 99, until: null }))).toBe(
      "RRULE:FREQ=DAILY;INTERVAL=99"
    );
  });

  test("an all-day series ends on a DATE UNTIL and skips DATE EXDATEs", () => {
    const out = lines(
      buildIcsCalendar({
        name: "Feed",
        events: [
          allDay("2026-10-01", { freq: "daily", interval: 3, until: "2026-10-10" }, [
            "2026-10-04",
            "2026-10-07",
          ]),
        ],
      })
    );
    expect(out).toContain("RRULE:FREQ=DAILY;INTERVAL=3;UNTIL=20261010");
    expect(out).toContain("EXDATE;VALUE=DATE:20261004");
    expect(out).toContain("EXDATE;VALUE=DATE:20261007");
  });

  test("a timed series ends on the UTC instant of its last start, in winter time too", () => {
    expect(
      rruleOf(timedIn("Europe/Prague", { freq: "weekly", interval: 1, until: "2026-12-29" }))
    ).toBe("RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261229T080000Z");
  });

  test("an event without a repeat carries no RRULE and no EXDATE", () => {
    const out = buildIcsCalendar({
      name: "Feed",
      events: [{ ...allDay("2026-10-01", { freq: "daily", ...forever }), repeat: undefined }],
    });
    expect(out).not.toContain("RRULE");
    expect(out).not.toContain("EXDATE");
  });
});

describe("buildIcsCalendar, VTIMEZONE (S10)", () => {
  const vtimezone = (timeZone: string) =>
    block(
      buildIcsCalendar({ name: "Feed", events: [timedIn(timeZone)] }),
      "BEGIN:VTIMEZONE",
      "END:VTIMEZONE"
    );

  test("America/New_York switches on the 2nd Sunday of March and the 1st of November", () => {
    expect(vtimezone("America/New_York")).toEqual([
      "BEGIN:VTIMEZONE",
      "TZID:America/New_York",
      "BEGIN:DAYLIGHT",
      "DTSTART:19700308T020000",
      "TZOFFSETFROM:-0500",
      "TZOFFSETTO:-0400",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
      "END:DAYLIGHT",
      "BEGIN:STANDARD",
      "DTSTART:19701101T020000",
      "TZOFFSETFROM:-0400",
      "TZOFFSETTO:-0500",
      "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
      "END:STANDARD",
      "END:VTIMEZONE",
    ]);
  });

  test("Australia/Sydney has its daylight saving across the new year", () => {
    expect(vtimezone("Australia/Sydney")).toEqual([
      "BEGIN:VTIMEZONE",
      "TZID:Australia/Sydney",
      "BEGIN:DAYLIGHT",
      "DTSTART:19701004T020000",
      "TZOFFSETFROM:+1000",
      "TZOFFSETTO:+1100",
      "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU",
      "END:DAYLIGHT",
      "BEGIN:STANDARD",
      "DTSTART:19700405T030000",
      "TZOFFSETFROM:+1100",
      "TZOFFSETTO:+1000",
      "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU",
      "END:STANDARD",
      "END:VTIMEZONE",
    ]);
  });

  test("a zone whose transitions fit no weekday rule gets that year's fixed offsets and logs once", () => {
    warn.mockClear();
    const first = vtimezone("Africa/Casablanca");
    vtimezone("Africa/Casablanca");

    const starts = first.filter((line) => line.startsWith("DTSTART:"));
    expect(starts.length).toBeGreaterThan(0);
    expect(starts.every((line) => line.startsWith("DTSTART:2026"))).toBe(true);
    expect(first.some((line) => line.startsWith("RRULE:"))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("ics.vtimezone.fixed_offsets", {
      timeZone: "Africa/Casablanca",
      year: 2026,
    });
  });

  test("each zone in use gets one VTIMEZONE, however many events use it", () => {
    const out = buildIcsCalendar({
      name: "Feed",
      events: [timedIn("Europe/Prague"), timedIn("Asia/Tokyo"), timedIn("Europe/Prague")],
    });
    expect(lines(out).filter((line) => line.startsWith("TZID:"))).toEqual([
      "TZID:Europe/Prague",
      "TZID:Asia/Tokyo",
    ]);
    expect(out.indexOf("END:VTIMEZONE")).toBeLessThan(out.indexOf("BEGIN:VEVENT"));
  });

  test("a single timed event carries its TZID and no repeat", () => {
    const event = block(
      buildIcsCalendar({
        name: "Feed",
        events: [{ ...timedIn("Europe/Prague"), endDate: "2026-10-21", endTime: "17:30:00" }],
      }),
      "BEGIN:VEVENT",
      "END:VEVENT"
    );
    expect(event).toEqual([
      "BEGIN:VEVENT",
      "UID:ge-Europe/Prague@flexiday",
      "DTSTART;TZID=Europe/Prague:20261020T090000",
      "DTEND;TZID=Europe/Prague:20261021T173000",
      "SUMMARY:Standup",
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    ]);
  });
});

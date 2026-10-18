import type { Request, Response } from "express";
import { z } from "zod";
import AppError from "../../utils/appError.js";
import { buildIcsCalendar, type IcsEvent } from "../../utils/ics.js";
import {
  birthdayLabel,
  groupEventGroupLine,
  recordTypeLabels,
  type RecordTypeLabels,
} from "../../services/recordType/recordTypeLabels.js";
import { getUserLanguage } from "../../services/userSettings/userSettingsServices.js";
import { calendarSyncScope } from "../../db/schema/calendar-sync-schema.js";
import type {
  BirthdayFeedRecord,
  CalendarFeedRecord,
  GroupEventFeedRecord,
  VacationFeedRecord,
} from "../../services/calendarSync/types.js";
import {
  groupEventDescription,
  groupEventIcs,
} from "../../services/calendarSync/groupEventShape.js";
import {
  getCalendarSyncByToken,
  getFeedRecords,
  touchLastFetched,
} from "../../services/calendarSync/calendarSyncServices.js";

// Feed tokens are `flx_live_` + 40 hex chars. Reject anything else before
// touching the database so scanners don't generate lookups.
const validateToken = z.string().regex(/^flx_live_[a-f0-9]{40}$/, "Invalid feed token");

const vacationEvent = (record: VacationFeedRecord, labels: RecordTypeLabels): IcsEvent => {
  const label = labels[record.vacationType];
  return {
    uid: `${record.id}@flexiday`,
    startDate: record.requestedDay,
    endDate: record.requestedDay,
    summary: `${record.userName} — ${label}`,
    description: record.note ?? undefined,
    categories: [label],
  };
};

/** "Birthday" on a personal feed, the person's name before it on a team feed. Never an age. */
const birthdayEvent = (record: BirthdayFeedRecord, label: string, team: boolean): IcsEvent => ({
  uid: `bd-${record.userId}@flexiday`,
  startDate: record.startDate,
  summary: team ? `${record.userName} — ${label}` : label,
  categories: [label],
  repeat: {
    freq: "yearly",
    interval: 1,
    until: null,
    yearlyOn: { month: record.month, day: record.day },
  },
});

/** A group event in the feed's own zone (D7), with the line naming its group. */
const groupEventEvent = (
  record: GroupEventFeedRecord,
  groupLine: string,
  timeZone: string
): IcsEvent =>
  groupEventIcs(
    record,
    {
      uid: `ge-${record.id}@flexiday`,
      summary: record.title,
      description: groupEventDescription(record, groupLine),
    },
    timeZone
  );

/**
 * Public, token-authenticated iCalendar feed. Mounted OUTSIDE `authSession`:
 * the token in the URL is the only credential, so calendar clients (which
 * cannot send session cookies) can subscribe. Always responds with
 * `text/calendar` on success.
 */
export const handleGetCalendarFeed = async (req: Request, res: Response) => {
  const parsed = validateToken.safeParse(req.params.token);
  if (!parsed.success) {
    throw new AppError({ code: 404, message: "Calendar feed not found" });
  }

  const config = await getCalendarSyncByToken(parsed.data);

  if (!config) {
    throw new AppError({
      code: 404,
      message: "Calendar feed not found",
      context: { token: parsed.data },
    });
  }

  const records = await getFeedRecords(config);
  const language = await getUserLanguage(config.userId);
  const labels = recordTypeLabels(language);
  const team = config.scope === calendarSyncScope.Team;

  const toEvent = (record: CalendarFeedRecord): IcsEvent => {
    switch (record.kind) {
      case "birthday":
        return birthdayEvent(record, birthdayLabel(language), team);
      case "groupEvent":
        return groupEventEvent(
          record,
          groupEventGroupLine(language, record.groupName),
          config.timeZone
        );
      default:
        return vacationEvent(record, labels);
    }
  };
  const events = records.map(toEvent);

  const body = buildIcsCalendar({ name: config.name, events });

  // Best-effort "last fetched" bookkeeping; never fail the feed over it.
  try {
    await touchLastFetched(config.id);
  } catch {
    // ignore — the feed content is already computed and valid
  }

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `inline; filename="${config.id}.ics"`);
  res.setHeader("Cache-Control", "private, max-age=300");
  return res.status(200).send(body);
};

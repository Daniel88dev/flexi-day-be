import type { IcsEvent, IcsRepeat } from "../../utils/ics.js";
import type { RepeatRule } from "../groupEvent/occurrences.js";
import type { GroupEventFeedRecord } from "./types.js";

const icsRepeat = (rule: RepeatRule): IcsRepeat => ({
  freq: rule.freq,
  interval: rule.interval,
  weekdays: rule.weekdays,
  monthlyMode: rule.monthlyMode ?? undefined,
  until: rule.until,
});

/** A group event as the `.ics` writer takes it, timed ones stamped with `timeZone` (D7). */
export const groupEventIcs = (
  record: GroupEventFeedRecord,
  text: { uid: string; summary: string; description?: string },
  timeZone: string
): IcsEvent => {
  const repeat = record.repeat ? { repeat: icsRepeat(record.repeat) } : {};
  const skippedDates = record.repeat ? { skippedDates: [...record.skippedDates].sort() } : {};
  if (record.startTime && record.endTime) {
    return {
      ...text,
      kind: "timed",
      timeZone,
      startDate: record.startDate,
      startTime: record.startTime,
      endDate: record.endDate,
      endTime: record.endTime,
      ...repeat,
      ...skippedDates,
    };
  }
  return {
    ...text,
    startDate: record.startDate,
    endDate: record.endDate,
    ...repeat,
    ...skippedDates,
  };
};

/** The note, then the line naming the group. */
export const groupEventDescription = (record: GroupEventFeedRecord, groupLine: string): string => {
  const note = record.note?.trim();
  return note ? `${note}\n${groupLine}` : groupLine;
};

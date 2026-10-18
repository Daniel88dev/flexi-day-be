import AppError from "../../utils/appError.js";
import {
  daysBetween,
  occurrences,
  plusDays,
  type IsoDate,
  type RepeatRule,
} from "./occurrences.js";
import { clock, repeatColumns, repeatRuleOf } from "./groupEventServices.js";
import {
  groupEventShapeIssues,
  type GroupEventChanges,
  type GroupEventColumns as Columns,
  type GroupEventDeleteRequest,
  type GroupEventEditRequest,
  type GroupEventPlan,
  type GroupEventRecord,
  type GroupEventShape,
} from "./types.js";

const unprocessable = (message: string) => new AppError({ code: 422, message });

const shapeOf = (row: GroupEventRecord): GroupEventShape => ({
  title: row.title ?? "",
  note: row.note,
  startDate: row.startDate,
  endDate: row.endDate,
  startTime: clock(row.startTime),
  endTime: clock(row.endTime),
  repeat: repeatRuleOf(row),
});

const shapeColumns = (shape: GroupEventShape): Columns => ({
  title: shape.title,
  note: shape.note,
  startDate: shape.startDate,
  endDate: shape.endDate,
  startTime: shape.startTime,
  endTime: shape.endTime,
  ...repeatColumns(shape.repeat),
});

/** A missing change keeps the value; a moved start keeps the event's length. */
const merge = (base: GroupEventShape, changes: GroupEventChanges): GroupEventShape => {
  const startDate = changes.startDate ?? base.startDate;
  return {
    title: changes.title ?? base.title,
    note: changes.note !== undefined ? changes.note : base.note,
    startDate,
    endDate: changes.endDate ?? plusDays(base.endDate, daysBetween(base.startDate, startDate)),
    startTime: changes.startTime !== undefined ? changes.startTime : base.startTime,
    endTime: changes.endTime !== undefined ? changes.endTime : base.endTime,
    repeat: changes.repeat !== undefined ? changes.repeat : base.repeat,
  };
};

const assertShape = (shape: GroupEventShape) => {
  const issues = groupEventShapeIssues(shape);
  if (issues.length > 0) throw unprocessable(issues.map((issue) => issue.message).join("; "));
};

/** Same rule apart from `until`. */
const samePattern = (a: RepeatRule, b: RepeatRule) =>
  a.freq === b.freq &&
  a.interval === b.interval &&
  a.monthlyMode === b.monthlyMode &&
  a.weekdays.join() === b.weekdays.join();

const sortedUnique = (dates: IsoDate[]) => [...new Set(dates)].sort();

const recurringRule = (event: GroupEventRecord, request: { scope?: string }) => {
  const rule = repeatRuleOf(event);
  if (rule && !request.scope) {
    throw unprocessable("Give a `scope` for a recurring group event");
  }
  return rule;
};

/** `occurrenceDate` must be a date the rule produces and has not skipped. */
const occurrenceOf = (event: GroupEventRecord, occurrenceDate: IsoDate | undefined): IsoDate => {
  if (!occurrenceDate) throw unprocessable("Give the `occurrenceDate` this scope starts from");
  const found = occurrences(
    {
      startDate: event.startDate,
      endDate: event.endDate,
      repeat: repeatRuleOf(event),
      skippedDates: event.skippedDates,
    },
    occurrenceDate,
    occurrenceDate
  ).some((occurrence) => occurrence.startDate === occurrenceDate);
  if (!found) throw unprocessable("`occurrenceDate` is not an occurrence of this group event");
  return occurrenceDate;
};

/**
 * What happens to the one-off changes (linked one-offs and skipped dates) of
 * the part of a recurring group event an edit rewrites. A rule or start change
 * drops them all; a change of `until` alone drops only those past it.
 */
const carryOneOffs = (input: {
  base: GroupEventShape;
  next: GroupEventShape;
  oneOffs: GroupEventRecord[];
  skippedDates: IsoDate[];
  targetId: string;
}) => {
  const { base, next, oneOffs, skippedDates, targetId } = input;
  const keepsAll =
    next.repeat !== null &&
    base.repeat !== null &&
    next.startDate === base.startDate &&
    samePattern(base.repeat, next.repeat);
  const until = next.repeat?.until ?? null;
  const survives = (date: IsoDate) => keepsAll && (until === null || date <= until);

  const kept = oneOffs.filter((oneOff) => survives(oneOff.originalDate!));
  const dropped = oneOffs.filter((oneOff) => !survives(oneOff.originalDate!));
  const backed = new Set(oneOffs.map((oneOff) => oneOff.originalDate));
  const droppedDeletions = skippedDates.filter((date) => !survives(date) && !backed.has(date));

  // "All events" changing title, note or times overwrites the one-offs' own.
  const overwrite: Columns = {};
  if (next.title !== base.title) overwrite.title = next.title;
  if (next.note !== base.note) overwrite.note = next.note;
  if (next.startTime !== base.startTime || next.endTime !== base.endTime) {
    overwrite.startTime = next.startTime;
    overwrite.endTime = next.endTime;
  }

  return {
    droppedOneOffs: dropped.length + droppedDeletions.length,
    skippedDates: sortedUnique(skippedDates.filter(survives)),
    tombstones: dropped.map((oneOff) => oneOff.id),
    updates: kept
      .map((oneOff) => ({
        id: oneOff.id,
        set: {
          ...overwrite,
          ...(oneOff.recurringEventId !== targetId ? { recurringEventId: targetId } : {}),
        },
      }))
      .filter((update) => Object.keys(update.set).length > 0),
  };
};

const emptyPlan = (): GroupEventPlan => ({
  droppedOneOffs: 0,
  updates: [],
  inserts: [],
  tombstones: [],
  needsActivePlan: false,
});

const planAll = (
  event: GroupEventRecord,
  oneOffs: GroupEventRecord[],
  changes: GroupEventChanges
): GroupEventPlan => {
  const base = shapeOf(event);
  const next = merge(base, changes);
  assertShape(next);
  const carried = carryOneOffs({
    base,
    next,
    oneOffs,
    skippedDates: event.skippedDates,
    targetId: event.id,
  });
  return {
    ...emptyPlan(),
    droppedOneOffs: carried.droppedOneOffs,
    updates: [
      { id: event.id, set: { ...shapeColumns(next), skippedDates: carried.skippedDates } },
      ...carried.updates,
    ],
    tombstones: carried.tombstones,
  };
};

const planThis = (
  event: GroupEventRecord,
  rule: RepeatRule,
  request: GroupEventEditRequest,
  newId: () => string
): GroupEventPlan => {
  const date = occurrenceOf(event, request.occurrenceDate);
  const { repeat, ...changes } = request.changes;
  if (
    repeat !== undefined &&
    !(repeat && samePattern(repeat, rule) && repeat.until === rule.until)
  ) {
    throw unprocessable("A new repeat rule can't apply to one date");
  }
  const next = merge({ ...shapeOf(event), startDate: date, endDate: date, repeat: null }, changes);
  assertShape(next);
  if (next.endDate !== next.startDate) throw unprocessable("A changed occurrence lasts one day");

  return {
    ...emptyPlan(),
    updates: [{ id: event.id, set: { skippedDates: sortedUnique([...event.skippedDates, date]) } }],
    inserts: [
      {
        ...shapeColumns(next),
        id: newId(),
        groupId: event.groupId,
        createdByUserId: event.createdByUserId,
        startDate: next.startDate,
        endDate: next.endDate,
        recurringEventId: event.id,
        originalDate: date,
      },
    ],
  };
};

const planFollowing = (
  event: GroupEventRecord,
  rule: RepeatRule,
  oneOffs: GroupEventRecord[],
  request: GroupEventEditRequest,
  newId: () => string
): GroupEventPlan => {
  const date = occurrenceOf(event, request.occurrenceDate);
  // From the first occurrence, "this and following" is every occurrence.
  if (date === event.startDate) return planAll(event, oneOffs, request.changes);

  const base = { ...shapeOf(event), startDate: date, endDate: date };
  const next = merge(base, request.changes);
  assertShape(next);

  const id = newId();
  const tail = oneOffs.filter((oneOff) => oneOff.originalDate! >= date);
  const carried = carryOneOffs({
    base,
    next,
    oneOffs: tail,
    skippedDates: event.skippedDates.filter((skipped) => skipped >= date),
    targetId: id,
  });

  return {
    droppedOneOffs: carried.droppedOneOffs,
    updates: [
      {
        id: event.id,
        set: {
          ...repeatColumns({ ...rule, until: plusDays(date, -1) }),
          skippedDates: event.skippedDates.filter((skipped) => skipped < date),
        },
      },
      ...carried.updates,
    ],
    inserts: [
      {
        ...shapeColumns(next),
        id,
        groupId: event.groupId,
        createdByUserId: event.createdByUserId,
        startDate: next.startDate,
        endDate: next.endDate,
        skippedDates: carried.skippedDates,
      },
    ],
    tombstones: carried.tombstones,
    needsActivePlan: true,
  };
};

/**
 * The writes of `PATCH /api/group-events/:id` for its scope, "this event",
 * "this and following" or "all events". `oneOffs` are the live one-offs linked
 * to `event`. Throws 422 when the request does not fit the event.
 */
export const planGroupEventEdit = (
  event: GroupEventRecord,
  oneOffs: GroupEventRecord[],
  request: GroupEventEditRequest,
  newId: () => string
): GroupEventPlan => {
  const rule = recurringRule(event, request);
  if (!rule) {
    const next = merge(shapeOf(event), request.changes);
    assertShape(next);
    // A one-off that starts repeating stands on its own.
    const unlink = next.repeat ? { recurringEventId: null, originalDate: null } : {};
    return {
      ...emptyPlan(),
      updates: [{ id: event.id, set: { ...shapeColumns(next), ...unlink } }],
      needsActivePlan: next.repeat !== null,
    };
  }

  switch (request.scope!) {
    case "this":
      return planThis(event, rule, request, newId);
    case "following":
      return planFollowing(event, rule, oneOffs, request, newId);
    case "all":
      return planAll(event, oneOffs, request.changes);
  }
};

/** The writes of `DELETE /api/group-events/:id` for its scope. Deletes are hard. */
export const planGroupEventDelete = (
  event: GroupEventRecord,
  oneOffs: GroupEventRecord[],
  request: GroupEventDeleteRequest
): GroupEventPlan => {
  const rule = recurringRule(event, request);
  const everything = { ...emptyPlan(), tombstones: [event.id, ...oneOffs.map((row) => row.id)] };
  if (!rule || request.scope === "all") return everything;

  const date = occurrenceOf(event, request.occurrenceDate);
  if (request.scope === "this") {
    return {
      ...emptyPlan(),
      updates: [
        { id: event.id, set: { skippedDates: sortedUnique([...event.skippedDates, date]) } },
      ],
    };
  }

  if (date === event.startDate) return everything;
  return {
    ...emptyPlan(),
    updates: [
      {
        id: event.id,
        set: {
          ...repeatColumns({ ...rule, until: plusDays(date, -1) }),
          skippedDates: event.skippedDates.filter((skipped) => skipped < date),
        },
      },
    ],
    tombstones: oneOffs.filter((oneOff) => oneOff.originalDate! >= date).map((row) => row.id),
  };
};

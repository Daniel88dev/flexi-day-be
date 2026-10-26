import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { user } from "../../db/schema/auth-schema.js";
import {
  groupEventMonthlyMode,
  groupEventRepeatFreq,
  groupEvents,
} from "../../db/schema/group-event-schema.js";
import { buildUserSummary } from "../../utils/userPresentation.js";
import { plusDays, occurrences, type IsoDate, type RepeatRule } from "./occurrences.js";
import {
  GROUP_EVENT_READ_LIMIT,
  type CreateGroupEventBody,
  type GroupEventPlan,
  type GroupEventRecord,
  type GroupEventView,
} from "./types.js";
import { personName } from "../person/personName.js";

const FREQ_TO_DB = {
  daily: groupEventRepeatFreq.Daily,
  weekly: groupEventRepeatFreq.Weekly,
  monthly: groupEventRepeatFreq.Monthly,
  yearly: groupEventRepeatFreq.Yearly,
} as const;

const FREQ_FROM_DB = {
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
  YEARLY: "yearly",
} as const;

const MODE_TO_DB = {
  day: groupEventMonthlyMode.Day,
  weekday: groupEventMonthlyMode.NthWeekday,
  lastWeekday: groupEventMonthlyMode.LastWeekday,
} as const;

const MODE_FROM_DB = { DAY: "day", NTH_WEEKDAY: "weekday", LAST_WEEKDAY: "lastWeekday" } as const;

/** The repeat columns for a rule; every one null for a one-off. */
export const repeatColumns = (rule: RepeatRule | null) => ({
  repeatFreq: rule ? FREQ_TO_DB[rule.freq] : null,
  repeatInterval: rule ? rule.interval : null,
  repeatWeekdays: rule?.freq === "weekly" ? rule.weekdays : null,
  repeatMonthlyMode:
    rule?.freq === "monthly" && rule.monthlyMode ? MODE_TO_DB[rule.monthlyMode] : null,
  repeatUntil: rule ? rule.until : null,
});

export const repeatRuleOf = (row: GroupEventRecord): RepeatRule | null => {
  if (!row.repeatFreq || row.repeatInterval === null) return null;
  return {
    freq: FREQ_FROM_DB[row.repeatFreq],
    interval: row.repeatInterval,
    weekdays: row.repeatWeekdays ?? [],
    monthlyMode: row.repeatMonthlyMode ? MODE_FROM_DB[row.repeatMonthlyMode] : null,
    until: row.repeatUntil,
  };
};

/** A `time` column in the API's `HH:MM` form. */
export const clock = (value: string | null) => (value === null ? null : value.slice(0, 5));

/** Who may create: a live membership of any kind, or administering the group. */
export const canCreateGroupEventIn = (access: { isMember: boolean; canAdmin: boolean }) =>
  access.isMember || access.canAdmin;

/** Who may edit: the creator while still a member, or anyone administering the group. */
export const canEditGroupEvent = (
  event: Pick<GroupEventRecord, "createdByUserId">,
  callerId: string,
  access: { isMember: boolean; canAdmin: boolean }
) => access.canAdmin || (event.createdByUserId === callerId && access.isMember);

export const toGroupEventView = (
  row: GroupEventRecord,
  context: {
    groupName: string;
    creator: { id: string; name: string } | null;
    canEdit: boolean;
  }
): GroupEventView => ({
  id: row.id,
  groupId: row.groupId,
  groupName: context.groupName,
  title: row.title ?? "",
  note: row.note,
  startDate: row.startDate,
  endDate: row.endDate,
  startTime: clock(row.startTime),
  endTime: clock(row.endTime),
  repeat: repeatRuleOf(row),
  skippedDates: [...row.skippedDates].sort(),
  recurringEventId: row.recurringEventId,
  originalDate: row.originalDate,
  createdBy: context.creator ? buildUserSummary(context.creator) : null,
  canEdit: context.canEdit,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const insertGroupEvent = async (
  values: { id: string; createdByUserId: string } & CreateGroupEventBody,
  tx?: DbTransaction
): Promise<GroupEventRecord> => {
  const [row] = await (tx ?? db)
    .insert(groupEvents)
    .values({
      id: values.id,
      groupId: values.groupId,
      createdByUserId: values.createdByUserId,
      title: values.title,
      note: values.note,
      startDate: values.startDate,
      endDate: values.endDate,
      startTime: values.startTime,
      endTime: values.endTime,
      ...repeatColumns(values.repeat),
    })
    .returning();
  return row!;
};

export type GroupEventWithCreator = {
  event: GroupEventRecord;
  creator: { id: string; name: string } | null;
};

/**
 * Live group events of the groups with at least one occurrence in the window,
 * `endDate` exclusive like `paddedMonthRange`. Reads at most
 * {@link GROUP_EVENT_READ_LIMIT} rows.
 */
export const listGroupEventsInWindow = async (
  groupIds: string[],
  window: { startDate: IsoDate; endDate: IsoDate },
  tx?: DbTransaction
): Promise<GroupEventWithCreator[]> => {
  if (groupIds.length === 0) return [];
  const rows = await (tx ?? db)
    .select({
      event: groupEvents,
      creatorId: user.id,
      creatorName: personName(user, { groupId: groupEvents.groupId }),
    })
    .from(groupEvents)
    .leftJoin(user, eq(user.id, groupEvents.createdByUserId))
    .where(
      and(
        inArray(groupEvents.groupId, groupIds),
        isNull(groupEvents.deletedAt),
        lt(groupEvents.startDate, window.endDate),
        or(
          and(isNull(groupEvents.repeatFreq), gte(groupEvents.endDate, window.startDate)),
          and(
            isNotNull(groupEvents.repeatFreq),
            or(isNull(groupEvents.repeatUntil), gte(groupEvents.repeatUntil, window.startDate))
          )
        )
      )
    )
    .orderBy(asc(groupEvents.startDate), asc(groupEvents.id))
    .limit(GROUP_EVENT_READ_LIMIT);

  const last = plusDays(window.endDate, -1);
  return rows
    .filter(
      ({ event }) =>
        occurrences(
          {
            startDate: event.startDate,
            endDate: event.endDate,
            repeat: repeatRuleOf(event),
            skippedDates: event.skippedDates,
          },
          window.startDate,
          last
        ).length > 0
    )
    .map(({ event, creatorId, creatorName }) => ({
      event,
      creator: creatorId && creatorName !== null ? { id: creatorId, name: creatorName } : null,
    }));
};

/** The live group event under a row lock, so concurrent edits never lose a skipped date. */
export const lockGroupEvent = async (
  id: string,
  tx: DbTransaction
): Promise<GroupEventRecord | undefined> => {
  const [row] = await tx
    .select()
    .from(groupEvents)
    .where(and(eq(groupEvents.id, id), isNull(groupEvents.deletedAt)))
    .for("update");
  return row;
};

/** The live one-offs a "this event" edit made of the recurring group event's occurrences. */
export const lockLinkedOneOffs = (recurringEventId: string, tx: DbTransaction) =>
  tx
    .select()
    .from(groupEvents)
    .where(and(eq(groupEvents.recurringEventId, recurringEventId), isNull(groupEvents.deletedAt)))
    .orderBy(asc(groupEvents.originalDate))
    .for("update");

/**
 * A tombstone keeps `id`, `groupId`, the dates and the one-off link, so the
 * pull and the sync engine can remove it everywhere; its content goes.
 */
const TOMBSTONE = {
  title: null,
  note: null,
  startTime: null,
  endTime: null,
  ...repeatColumns(null),
  skippedDates: [],
  createdByUserId: null,
};

/** Writes a plan from `editPlan.ts`. Answers the live rows it wrote, edited or created. */
export const applyGroupEventPlan = async (
  plan: GroupEventPlan,
  tx: DbTransaction
): Promise<GroupEventRecord[]> => {
  if (plan.tombstones.length > 0) {
    await tx
      .update(groupEvents)
      .set({ ...TOMBSTONE, deletedAt: new Date() })
      .where(inArray(groupEvents.id, plan.tombstones));
  }
  // Inserts first: a split's later one-offs link to the event it creates.
  const inserted =
    plan.inserts.length > 0 ? await tx.insert(groupEvents).values(plan.inserts).returning() : [];
  const updated: GroupEventRecord[] = [];
  for (const { id, set } of plan.updates) {
    const [row] = await tx.update(groupEvents).set(set).where(eq(groupEvents.id, id)).returning();
    updated.push(row!);
  }
  return [...updated, ...inserted];
};

/** Creator names for the views of `rows`. */
export const creatorsOf = async (
  rows: GroupEventRecord[],
  groupId: string,
  tx?: DbTransaction
): Promise<Map<string, { id: string; name: string }>> => {
  const creatorIds = [
    ...new Set(rows.map((row) => row.createdByUserId).filter((id): id is string => id !== null)),
  ];
  if (creatorIds.length === 0) return new Map();
  const found = await (tx ?? db)
    .select({ id: user.id, name: personName(user, { groupId }) })
    .from(user)
    .where(inArray(user.id, creatorIds));
  return new Map(found.map((creator) => [creator.id, creator]));
};

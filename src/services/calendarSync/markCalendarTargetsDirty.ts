import { and, eq, exists, inArray, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import { db } from "../../db/db.js";
import {
  calendarSync,
  calendarSyncScope,
  calendarSyncTypes,
} from "../../db/schema/calendar-sync-schema.js";
import {
  calendarConnection,
  calendarConnectionStatus,
} from "../../db/schema/calendar-connection-schema.js";
import type { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { logger } from "../../middleware/logger.js";
import { errorName } from "../../utils/errorName.js";
import { enqueueSync } from "./enqueueSync.js";
import type { DirtyRow } from "./types.js";

const activeConnection = () =>
  exists(
    db
      .select({ id: calendarConnection.id })
      .from(calendarConnection)
      .where(
        and(
          eq(calendarConnection.id, calendarSync.connectionId),
          eq(calendarConnection.status, calendarConnectionStatus.Active)
        )
      )
  );

/**
 * Marks due and enqueues every live, connected `ME` target on an active
 * connection that `carries` picks out. Each record kind brings its own
 * condition. Never throws; the change is already committed.
 */
const markTargetsDue = async (carries: () => SQL | undefined): Promise<void> => {
  try {
    const marked = await db
      .update(calendarSync)
      .set({ syncDueAt: new Date(), syncAttempts: 0 })
      .where(
        and(
          eq(calendarSync.scope, calendarSyncScope.Me),
          isNull(calendarSync.deletedAt),
          isNotNull(calendarSync.connectionId),
          activeConnection(),
          carries()
        )
      )
      .returning({ id: calendarSync.id });

    enqueueSync(marked.map((target) => target.id));
  } catch (error) {
    logger.error("calendar_sync.mark_dirty_failed", { error: errorName(error) });
  }
};

/**
 * After a commit that changed approved records: marks due every connected `ME`
 * target of the rows' owners whose type list includes a row's type, then
 * enqueues them. Never throws; the change is already committed.
 */
export const markCalendarTargetsDirty = async (rows: readonly DirtyRow[]): Promise<void> => {
  const typesByUser = new Map<string, Set<CalendarRecordType>>();
  for (const row of rows) {
    // Rows approved neither before nor after the change never reached a calendar.
    if (!row.approvedAt) continue;
    const types = typesByUser.get(row.userId) ?? new Set<CalendarRecordType>();
    types.add(row.vacationType);
    typesByUser.set(row.userId, types);
  }
  if (typesByUser.size === 0) return;

  const includesType = (types: Set<CalendarRecordType>) =>
    exists(
      db
        .select({ id: calendarSyncTypes.id })
        .from(calendarSyncTypes)
        .where(
          and(
            eq(calendarSyncTypes.calendarSyncId, calendarSync.id),
            inArray(calendarSyncTypes.vacationType, [...types])
          )
        )
    );

  await markTargetsDue(() =>
    or(
      ...[...typesByUser].map(([userId, types]) =>
        and(eq(calendarSync.userId, userId), includesType(types))
      )
    )
  );
};

/**
 * After a commit that wrote a user's own birthday: marks their connected `ME`
 * targets with Birthdays on. A colleague's birthday never reaches a target, so
 * nobody else's is touched.
 */
export const markBirthdayTargetsDirty = async (userId: string): Promise<void> =>
  markTargetsDue(() =>
    and(eq(calendarSync.userId, userId), eq(calendarSync.includeBirthdays, true))
  );

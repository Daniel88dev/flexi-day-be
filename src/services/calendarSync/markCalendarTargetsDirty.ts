import { and, eq, exists, inArray, isNotNull, isNull, or } from "drizzle-orm";
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

/**
 * After a commit that changed approved records: marks due every connected `ME`
 * target of the rows' owners whose type list includes a row's type, then
 * enqueues them. Never throws; the change is already committed.
 */
export const markCalendarTargetsDirty = async (rows: readonly DirtyRow[]): Promise<void> => {
  try {
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
    const activeConnection = exists(
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

    const marked = await db
      .update(calendarSync)
      .set({ syncDueAt: new Date(), syncAttempts: 0 })
      .where(
        and(
          eq(calendarSync.scope, calendarSyncScope.Me),
          isNull(calendarSync.deletedAt),
          isNotNull(calendarSync.connectionId),
          activeConnection,
          or(
            ...[...typesByUser].map(([userId, types]) =>
              and(eq(calendarSync.userId, userId), includesType(types))
            )
          )
        )
      )
      .returning({ id: calendarSync.id });

    enqueueSync(marked.map((target) => target.id));
  } catch (error) {
    logger.error("calendar_sync.mark_dirty_failed", { error: errorName(error) });
  }
};

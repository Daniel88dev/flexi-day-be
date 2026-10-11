import { eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { calendarSync } from "../../db/schema/calendar-sync-schema.js";
import { calendarSyncEvents } from "../../db/schema/calendar-connection-schema.js";

/**
 * Removes everything the app wrote for one target and switches the target off.
 * Today it drops the ledger locally; BE-4 (T-295) deletes each ledger event at
 * the provider first.
 */
export const purgeTarget = async (configId: string): Promise<void> => {
  await db.transaction(async (tx) => {
    await tx.delete(calendarSyncEvents).where(eq(calendarSyncEvents.calendarSyncId, configId));
    await tx
      .update(calendarSync)
      .set({
        connectionId: null,
        timeZone: null,
        syncDueAt: null,
        syncAttempts: 0,
        lastSyncedAt: null,
        lastError: null,
      })
      .where(eq(calendarSync.id, configId));
  });
};

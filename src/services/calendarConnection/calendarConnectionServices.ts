import { and, eq, isNull } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { calendarSync, calendarSyncScope } from "../../db/schema/calendar-sync-schema.js";
import AppError from "../../utils/appError.js";
import { CALENDAR_SYNC_TEAM_SCOPE, type AttachTargetInput } from "./types.js";
import type { CalendarSyncRecord } from "../calendarSync/types.js";

const teamScopeError = (context: Record<string, unknown>) =>
  new AppError({
    code: 400,
    message: "Only a calendar with your own records can sync to a connected account",
    publicContext: { code: CALENDAR_SYNC_TEAM_SCOPE },
    context,
  });

export const assertTargetAttachable = (config: { scope: calendarSyncScope }): void => {
  if (config.scope !== calendarSyncScope.Me) {
    throw teamScopeError({ scope: config.scope });
  }
};

export const attachTarget = async (
  input: AttachTargetInput,
  tx?: DbTransaction
): Promise<CalendarSyncRecord> => {
  const executor = tx ?? db;
  const owned = and(
    eq(calendarSync.id, input.configId),
    eq(calendarSync.userId, input.userId),
    isNull(calendarSync.deletedAt)
  );

  const [config] = await executor
    .select({ id: calendarSync.id, scope: calendarSync.scope })
    .from(calendarSync)
    .where(owned);
  if (!config) {
    throw new AppError({
      code: 404,
      message: "Calendar not found",
      context: { configId: input.configId, userId: input.userId },
    });
  }
  assertTargetAttachable(config);

  const [row] = await executor
    .update(calendarSync)
    .set({
      connectionId: input.connectionId,
      timeZone: input.timeZone,
      syncDueAt: new Date(),
      syncAttempts: 0,
      lastError: null,
    })
    .where(and(owned, eq(calendarSync.scope, calendarSyncScope.Me)))
    .returning();
  if (!row) {
    throw teamScopeError({ configId: input.configId });
  }
  return row;
};

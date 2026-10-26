import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { DbTransaction } from "../../db/db.js";
import { vacation } from "../../db/schema/vacation-schema.js";
import { vacationEventType } from "../../db/schema/vacation-event-schema.js";
import type { DateString } from "../../utils/dateFunc.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { createVacationEvents } from "../vacationEvent/vacationEventServices.js";
import type { VacationType } from "./types.js";

export const EMPLOYMENT_ENDED_REASON = "employment ended";
export const REMOVED_FROM_GROUP_REASON = "removed from group";

/**
 * Cancels what a person leaving these groups still has open there: every
 * pending request, whatever its date, and every approved booking after
 * `today`. Past bookings and today's stay as the record of what happened.
 * Writes a CANCELLED event per day in `tx` and notifies nobody; the caller
 * marks calendar targets dirty after the commit.
 */
export const cancelBookingsOnDeparture = async (
  input: {
    userId: string;
    groupIds: string[];
    today: DateString;
    actorUserId: string;
    reason: string;
  },
  tx: DbTransaction
): Promise<VacationType[]> => {
  if (input.groupIds.length === 0) return [];

  const cancelled = await tx
    .update(vacation)
    .set({ deletedAt: new Date(), deletedByUserId: input.actorUserId })
    .where(
      and(
        eq(vacation.userId, input.userId),
        inArray(vacation.groupId, input.groupIds),
        isNull(vacation.deletedAt),
        isNull(vacation.rejectedAt),
        or(isNull(vacation.approvedAt), gt(vacation.requestedDay, input.today))
      )
    )
    .returning();

  await createVacationEvents(
    cancelled.map((row) => ({
      id: generateRandomUUID(),
      vacationId: row.id,
      eventType: vacationEventType.Cancelled,
      actorUserId: input.actorUserId,
      reason: input.reason,
    })),
    tx
  );

  return cancelled;
};

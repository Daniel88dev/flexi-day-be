import { db, type DbTransaction } from "../../db/db.js";
import { vacationEvents } from "../../db/schema/vacation-event-schema.js";
import { asc, eq } from "drizzle-orm";
import { user } from "../../db/schema/auth-schema.js";
import { buildUserSummary } from "../../utils/userPresentation.js";
import type {
  VacationEventInsertType,
  VacationEventListItem,
  VacationEventRecord,
} from "./types.js";

/**
 * Appends one timeline entry. Callers pass the same transaction that performs
 * the state change so an event can never disagree with the vacation row.
 */
export const createVacationEvent = async (
  record: VacationEventInsertType,
  tx?: DbTransaction
): Promise<VacationEventRecord | undefined> => {
  const [row] = await (tx ?? db).insert(vacationEvents).values(record).returning();
  return row;
};

/**
 * Appends many entries at once — a multi-day request or a bulk approval
 * produces one event per vacation row.
 */
export const createVacationEvents = async (
  records: VacationEventInsertType[],
  tx?: DbTransaction
): Promise<VacationEventRecord[]> => {
  if (records.length === 0) return [];
  return (tx ?? db).insert(vacationEvents).values(records).returning();
};

/**
 * The timeline for one vacation row, oldest first, with each actor resolved
 * to a display summary.
 */
export const getVacationEvents = async (
  vacationId: string,
  tx?: DbTransaction
): Promise<VacationEventListItem[]> => {
  const rows = await (tx ?? db)
    .select({
      id: vacationEvents.id,
      vacationId: vacationEvents.vacationId,
      eventType: vacationEvents.eventType,
      actorUserId: vacationEvents.actorUserId,
      actorName: user.name,
      reason: vacationEvents.reason,
      createdAt: vacationEvents.createdAt,
    })
    .from(vacationEvents)
    .leftJoin(user, eq(vacationEvents.actorUserId, user.id))
    .where(eq(vacationEvents.vacationId, vacationId))
    .orderBy(asc(vacationEvents.createdAt));

  return rows.map(({ actorUserId, actorName, ...rest }) => ({
    ...rest,
    actor: actorUserId && actorName ? buildUserSummary({ id: actorUserId, name: actorName }) : null,
  }));
};

import { db, type DbTransaction } from "../../db/db.js";
import { vacationEventType } from "../../db/schema/vacation-event-schema.js";
import type { AuthSession } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { createDBServices } from "../DBServices.js";
import { assertGroupsWritable } from "../billing/guards.js";
import { assertMayDecide, assertStillPending } from "./decisionGuards.js";
import { assertApprovalWithinQuota } from "./quotaGuard.js";
import type { VacationType } from "./types.js";
import { notifyVacationDecision } from "./vacationNotifier.js";

const services = createDBServices();

type Decision = "approve" | "reject";

/**
 * What one transition supplies to the engine. Everything absent here — the
 * transaction boundary, the not-found and lost-race comparisons, the plan
 * writability check, and the ordering of the event append against the commit
 * — belongs to the engine, and is therefore written once.
 */
type Transition = {
  /** Rows named by the request that are still live; a short result is a not-found. */
  load: (tx: DbTransaction) => Promise<VacationType[]>;
  requestedCount: number;
  /** This route's own wording for a load that came back short. */
  notFound: (rows: VacationType[]) => AppError;
  authorize: (rows: VacationType[], tx: DbTransaction) => Promise<void>;
  /** Only the approving transitions have one. */
  assertWithinQuota?: (rows: VacationType[], tx: DbTransaction) => Promise<void>;
  mutate: (tx: DbTransaction) => Promise<VacationType[]>;
  /** This route's own wording for a mutation that moved fewer rows than it loaded. */
  lostRace: (updated: VacationType[]) => AppError;
  appendEvents: (updated: VacationType[], tx: DbTransaction) => Promise<void>;
  notify: (updated: VacationType[]) => Promise<void>;
};

/**
 * The sequence every vacation transition follows. Holding it in one place is
 * what keeps the event in the same transaction as the change it records, and
 * the mail strictly after that transaction commits.
 */
const runTransition = async (transition: Transition): Promise<VacationType[]> => {
  const updated = await db.transaction(async (tx) => {
    const rows = await transition.load(tx);
    if (rows.length !== transition.requestedCount) throw transition.notFound(rows);

    await transition.authorize(rows, tx);
    await assertGroupsWritable(
      rows.map((row) => row.groupId),
      tx
    );
    await transition.assertWithinQuota?.(rows, tx);

    const changed = await transition.mutate(tx);
    if (changed.length !== rows.length) throw transition.lostRace(changed);

    await transition.appendEvents(changed, tx);
    return changed;
  });

  // Best-effort: the notifier logs its own failures so a mail problem cannot
  // turn a completed decision into an error for the approver.
  await transition.notify(updated);
  return updated;
};

const loadOne =
  (vacationId: string) =>
  async (tx: DbTransaction): Promise<VacationType[]> => {
    const row = await services.vacation.getVacationById(vacationId, tx);
    return row ? [row] : [];
  };

const loadMany =
  (vacationIds: string[]) =>
  (tx: DbTransaction): Promise<VacationType[]> =>
    services.vacation.getVacationsByIds(vacationIds, tx);

const oneNotFound = (auth: AuthSession, vacationId: string) => () =>
  new AppError({
    code: 404,
    message: "Vacation not found",
    context: { auth, vacationId },
  });

const someNotFound = (auth: AuthSession, vacationIds: string[]) => (rows: VacationType[]) =>
  new AppError({
    code: 404,
    message: "One or more vacations not found",
    context: { auth, requested: vacationIds.length, found: rows.length },
  });

const mayDecide =
  (auth: AuthSession, decision: Decision) =>
  async (rows: VacationType[], tx: DbTransaction): Promise<void> => {
    await assertMayDecide(auth.userId, rows, decision, tx);
    assertStillPending(rows);
  };

const oneAlreadyDecided = (auth: AuthSession, vacationId: string) => () =>
  new AppError({
    code: 409,
    message: "This request has already been decided",
    logging: true,
    context: { auth, vacationId },
  });

const someAlreadyDecided =
  (auth: AuthSession, vacationIds: string[]) => (updated: VacationType[]) =>
    new AppError({
      code: 409,
      message: "One or more of these requests has already been decided",
      logging: true,
      context: { auth, requested: vacationIds, updated: updated.map((row) => row.id) },
    });

const appendEventsRowByRow =
  (auth: AuthSession, eventType: vacationEventType, reason: string | null) =>
  async (updated: VacationType[], tx: DbTransaction): Promise<void> => {
    for (const row of updated) {
      await services.vacationEvent.createVacationEvent(
        {
          id: generateRandomUUID(),
          vacationId: row.id,
          eventType,
          actorUserId: auth.userId,
          reason,
        },
        tx
      );
    }
  };

const appendEventsInOneInsert =
  (auth: AuthSession, eventType: vacationEventType, reason: string | null) =>
  async (updated: VacationType[], tx: DbTransaction): Promise<void> => {
    await services.vacationEvent.createVacationEvents(
      updated.map((row) => ({
        id: generateRandomUUID(),
        vacationId: row.id,
        eventType,
        actorUserId: auth.userId,
        reason,
      })),
      tx
    );
  };

// A bulk decision can span several requesters, so the notifier fans out one
// mail per person.
const notifyDecision =
  (auth: AuthSession, decision: "approved" | "rejected", reason: string | null) =>
  (updated: VacationType[]): Promise<void> =>
    notifyVacationDecision(updated, decision, { id: auth.userId, name: auth.userName }, reason);

export const approveRequest = (params: {
  auth: AuthSession;
  vacationId: string;
  reason: string | null;
}): Promise<VacationType[]> => {
  const { auth, vacationId, reason } = params;

  return runTransition({
    load: loadOne(vacationId),
    requestedCount: 1,
    notFound: oneNotFound(auth, vacationId),
    authorize: mayDecide(auth, "approve"),
    assertWithinQuota: assertApprovalWithinQuota,
    mutate: async (tx) => {
      const row = await services.vacation.approveVacation(vacationId, auth.userId, tx);
      return row ? [row] : [];
    },
    lostRace: oneAlreadyDecided(auth, vacationId),
    appendEvents: appendEventsRowByRow(auth, vacationEventType.Approved, reason),
    // An approval carries its note to the timeline, never to the mail.
    notify: notifyDecision(auth, "approved", null),
  });
};

export const approveRequestBatch = (params: {
  auth: AuthSession;
  vacationIds: string[];
}): Promise<VacationType[]> => {
  const { auth } = params;
  const vacationIds = Array.from(new Set(params.vacationIds));

  return runTransition({
    load: loadMany(vacationIds),
    requestedCount: vacationIds.length,
    notFound: someNotFound(auth, vacationIds),
    authorize: mayDecide(auth, "approve"),
    assertWithinQuota: assertApprovalWithinQuota,
    mutate: (tx) => services.vacation.approveVacationsBulk(vacationIds, auth.userId, tx),
    lostRace: someAlreadyDecided(auth, vacationIds),
    appendEvents: appendEventsInOneInsert(auth, vacationEventType.Approved, null),
    notify: notifyDecision(auth, "approved", null),
  });
};

export const rejectRequest = (params: {
  auth: AuthSession;
  vacationId: string;
  reason: string | null;
}): Promise<VacationType[]> => {
  const { auth, vacationId, reason } = params;

  return runTransition({
    load: loadOne(vacationId),
    requestedCount: 1,
    notFound: oneNotFound(auth, vacationId),
    authorize: mayDecide(auth, "reject"),
    mutate: async (tx) => {
      const row = await services.vacation.rejectVacation(vacationId, auth.userId, reason, tx);
      return row ? [row] : [];
    },
    lostRace: oneAlreadyDecided(auth, vacationId),
    appendEvents: appendEventsRowByRow(auth, vacationEventType.Rejected, reason),
    notify: notifyDecision(auth, "rejected", reason),
  });
};

export const rejectRequestBatch = (params: {
  auth: AuthSession;
  vacationIds: string[];
  reason: string | null;
}): Promise<VacationType[]> => {
  const { auth, reason } = params;
  const vacationIds = Array.from(new Set(params.vacationIds));

  return runTransition({
    load: loadMany(vacationIds),
    requestedCount: vacationIds.length,
    notFound: someNotFound(auth, vacationIds),
    authorize: mayDecide(auth, "reject"),
    mutate: (tx) => services.vacation.rejectVacationsBulk(vacationIds, auth.userId, reason, tx),
    lostRace: someAlreadyDecided(auth, vacationIds),
    appendEvents: appendEventsInOneInsert(auth, vacationEventType.Rejected, reason),
    notify: notifyDecision(auth, "rejected", reason),
  });
};

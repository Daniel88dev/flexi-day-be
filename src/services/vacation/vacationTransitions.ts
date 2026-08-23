import { db, type DbTransaction } from "../../db/db.js";
import { vacationEventType } from "../../db/schema/vacation-event-schema.js";
import type { AuthSession } from "../../middleware/authSession.js";
import AppError from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { createDBServices } from "../DBServices.js";
import { assertGroupsWritable } from "../billing/guards.js";
import { assertMayDecide, assertStillPending, type Decision } from "./decisionGuards.js";
import { assertApprovalWithinQuota } from "./quotaGuard.js";
import type { VacationType } from "./types.js";
import {
  notifyVacationCancelled,
  notifyVacationComment,
  notifyVacationDecision,
  notifyVacationsCancelled,
} from "./vacationNotifier.js";
import { resolveCanCancelForList, resolveVacationPermissions } from "./vacationPermissions.js";

const services = createDBServices();

const actorOf = (auth: AuthSession) => ({ id: auth.userId, name: auth.userName });

/**
 * The two views of a transition's rows. They part company on the routes that
 * mail about what a record *was*: a cancellation notice reads the approval
 * stamp the cancellation has just cleared.
 */
type TransitionRows = {
  loaded: VacationType[];
  /** What the mutation returned — the loaded rows when there is no mutation. */
  changed: VacationType[];
};

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
  /** Absent on a comment, which changes no vacation row at all. */
  mutate?: (tx: DbTransaction) => Promise<VacationType[]>;
  /**
   * This route's own wording for a mutation that moved fewer rows than it
   * loaded. Absent where the route runs no such check.
   */
  lostRace?: (updated: VacationType[]) => AppError;
  appendEvents: (updated: VacationType[], tx: DbTransaction) => Promise<void>;
  notify: (rows: TransitionRows) => Promise<void>;
};

/**
 * The sequence every vacation transition follows. Holding it in one place is
 * what keeps the event in the same transaction as the change it records, and
 * the mail strictly after that transaction commits.
 */
const runTransition = async (transition: Transition): Promise<TransitionRows> => {
  const rows = await db.transaction(async (tx) => {
    const loaded = await transition.load(tx);
    if (loaded.length !== transition.requestedCount) throw transition.notFound(loaded);

    await transition.authorize(loaded, tx);
    await assertGroupsWritable(
      loaded.map((row) => row.groupId),
      tx
    );
    await transition.assertWithinQuota?.(loaded, tx);

    const changed = (await transition.mutate?.(tx)) ?? loaded;
    if (transition.lostRace && changed.length !== loaded.length) {
      throw transition.lostRace(changed);
    }

    await transition.appendEvents(changed, tx);
    return { loaded, changed };
  });

  // Best-effort: the notifier logs its own failures so a mail problem cannot
  // turn a completed decision into an error for the approver.
  await transition.notify(rows);
  return rows;
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
  ({ changed }: TransitionRows): Promise<void> =>
    notifyVacationDecision(changed, decision, actorOf(auth), reason);

const mayCancel =
  (auth: AuthSession, forbidden: (unauthorized: VacationType[]) => AppError) =>
  async (rows: VacationType[], tx: DbTransaction): Promise<void> => {
    const canCancel = await resolveCanCancelForList(auth.userId, rows, tx);

    const unauthorized = rows.filter((row) => !canCancel(row));
    if (unauthorized.length > 0) throw forbidden(unauthorized);
  };

const mayComment =
  (auth: AuthSession, vacationId: string) =>
  async (rows: VacationType[], tx: DbTransaction): Promise<void> => {
    // The engine has already thrown a not-found for a short load, so this
    // cannot fire. It throws rather than returns so that a guard can never
    // fail open if that ordering ever changes.
    const row = rows[0];
    if (!row) {
      throw new AppError({
        code: 500,
        message: "Failed to add comment",
        logging: true,
        context: { auth, vacationId },
      });
    }

    const permissions = await resolveVacationPermissions(auth.userId, row, tx);
    if (!permissions.canView) {
      throw new AppError({
        code: 403,
        message: "You are not allowed to comment on this vacation",
        logging: true,
        context: { userId: auth.userId, vacationId },
      });
    }
  };

// The single-record notifiers take a row rather than an array. The empty case
// is unreachable — a short load has already thrown — but the index type says
// otherwise.
const notifyFirstLoaded =
  (notifier: (row: VacationType) => Promise<void>) =>
  ({ loaded }: TransitionRows): Promise<void> => {
    const row = loaded[0];
    return row ? notifier(row) : Promise.resolve();
  };

export const approveRequest = async (params: {
  auth: AuthSession;
  vacationId: string;
  reason: string | null;
}): Promise<VacationType[]> => {
  const { auth, vacationId, reason } = params;

  const { changed } = await runTransition({
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

  return changed;
};

export const approveRequestBatch = async (params: {
  auth: AuthSession;
  vacationIds: string[];
}): Promise<VacationType[]> => {
  const { auth } = params;
  const vacationIds = Array.from(new Set(params.vacationIds));

  const { changed } = await runTransition({
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

  return changed;
};

export const rejectRequest = async (params: {
  auth: AuthSession;
  vacationId: string;
  reason: string | null;
}): Promise<VacationType[]> => {
  const { auth, vacationId, reason } = params;

  const { changed } = await runTransition({
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

  return changed;
};

export const rejectRequestBatch = async (params: {
  auth: AuthSession;
  vacationIds: string[];
  reason: string | null;
}): Promise<VacationType[]> => {
  const { auth, reason } = params;
  const vacationIds = Array.from(new Set(params.vacationIds));

  const { changed } = await runTransition({
    load: loadMany(vacationIds),
    requestedCount: vacationIds.length,
    notFound: someNotFound(auth, vacationIds),
    authorize: mayDecide(auth, "reject"),
    mutate: (tx) => services.vacation.rejectVacationsBulk(vacationIds, auth.userId, reason, tx),
    lostRace: someAlreadyDecided(auth, vacationIds),
    appendEvents: appendEventsInOneInsert(auth, vacationEventType.Rejected, reason),
    notify: notifyDecision(auth, "rejected", reason),
  });

  return changed;
};

export const cancelRequest = async (params: {
  auth: AuthSession;
  vacationId: string;
  reason: string | null;
}): Promise<void> => {
  const { auth, vacationId, reason } = params;

  await runTransition({
    load: loadOne(vacationId),
    requestedCount: 1,
    notFound: oneNotFound(auth, vacationId),
    authorize: mayCancel(
      auth,
      () =>
        new AppError({
          code: 403,
          message: "You are not allowed to cancel this vacation",
          logging: true,
          context: { auth, vacationId },
        })
    ),
    mutate: async (tx) => {
      const row = await services.vacation.deleteVacation(vacationId, auth.userId, tx);
      return row ? [row] : [];
    },
    // Answering a lost race with a 500 is what this route does today; its
    // siblings answer 409.
    lostRace: () =>
      new AppError({
        code: 500,
        message: "Failed to cancel vacation",
        logging: true,
        context: { auth, vacationId },
      }),
    appendEvents: appendEventsRowByRow(auth, vacationEventType.Cancelled, reason),
    // The cancelled row no longer carries the approval stamp the notifier reads
    // to decide whether the cancellation is worth an email.
    notify: notifyFirstLoaded((row) => notifyVacationCancelled(row, actorOf(auth), reason)),
  });
};

export const cancelRequestBatch = async (params: {
  auth: AuthSession;
  vacationIds: string[];
  reason: string | null;
}): Promise<VacationType[]> => {
  const { auth, reason } = params;
  const vacationIds = Array.from(new Set(params.vacationIds));

  // No `lostRace`: this route runs no such check today, so its count reports
  // the rows it loaded even when the update moved fewer.
  const { loaded } = await runTransition({
    load: loadMany(vacationIds),
    requestedCount: vacationIds.length,
    notFound: someNotFound(auth, vacationIds),
    authorize: mayCancel(
      auth,
      (unauthorized) =>
        new AppError({
          code: 403,
          message: "You are not allowed to cancel one or more of these vacations",
          logging: true,
          context: { auth, unauthorized: unauthorized.map((row) => row.id) },
        })
    ),
    mutate: (tx) => services.vacation.cancelVacationsBulk(vacationIds, auth.userId, tx),
    appendEvents: appendEventsInOneInsert(auth, vacationEventType.Cancelled, reason),
    notify: ({ loaded: rows }) => notifyVacationsCancelled(rows, actorOf(auth), reason),
  });

  return loaded;
};

export const commentOnRequest = async (params: {
  auth: AuthSession;
  vacationId: string;
  message: string;
}): Promise<void> => {
  const { auth, vacationId, message } = params;

  await runTransition({
    load: loadOne(vacationId),
    requestedCount: 1,
    notFound: oneNotFound(auth, vacationId),
    authorize: mayComment(auth, vacationId),
    appendEvents: appendEventsRowByRow(auth, vacationEventType.Comment, message),
    notify: notifyFirstLoaded((row) => notifyVacationComment(row, actorOf(auth), message)),
  });
};

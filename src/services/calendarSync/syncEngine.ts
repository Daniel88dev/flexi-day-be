import { and, eq, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db } from "../../db/db.js";
import { calendarSync } from "../../db/schema/calendar-sync-schema.js";
import {
  calendarCapability,
  calendarConnection,
  calendarConnectionStatus,
  calendarProvider,
  calendarSyncEvents,
} from "../../db/schema/calendar-connection-schema.js";
import { logger } from "../../middleware/logger.js";
import { errorName } from "../../utils/errorName.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import {
  connectionTokenSource,
  markNeedsReconnect,
} from "../calendarConnection/calendarConnectionServices.js";
import { isCalendarSyncEntitled } from "../calendarConnection/entitlement.js";
import type {
  CalendarConnectionRecord,
  CalendarSyncEventRecord,
} from "../calendarConnection/types.js";
import { getCalendarSyncById, getFeedRecords } from "./calendarSyncServices.js";
import { calendarDriver } from "./drivers/index.js";
import type { CalendarDriver, DriverContext, DriverFailure } from "./drivers/types.js";
import {
  buildBirthdayDesired,
  buildDesired,
  buildGroupEventDesired,
  graphTimeZone,
  seriesShapeOf,
  type DesiredEvent,
} from "./eventBuilder.js";
import {
  birthdayLabel,
  groupEventGroupLine,
  recordTypeLabels,
  type RecordTypeLabels,
} from "../recordType/recordTypeLabels.js";
import { getUserLanguage } from "../userSettings/userSettingsServices.js";
import type { CalendarFeedRecord, SyncOutcome } from "./types.js";
import { syncSourcesOf, type SyncSource } from "./sourceKey.js";

const DONE: SyncOutcome = { status: "done" };
const LEASE = sql`now() + interval '10 minutes'`;
const PURGE_LEASE_WAIT_MS = 30_000;
const PURGE_LEASE_POLL_MS = 500;
const PURGE_DELETE_RETRIES = 3;
const PURGE_RETRY_CAP_SECONDS = 5;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const locks = new Map<string, Promise<unknown>>();

// The in-process fast path; the lease below is what holds across instances.
const withConnectionLock = async <T>(connectionId: string, work: () => Promise<T>): Promise<T> => {
  const current = (locks.get(connectionId) ?? Promise.resolve()).then(work);
  const tail = current.catch(() => undefined);
  locks.set(connectionId, tail);
  try {
    return await current;
  } finally {
    if (locks.get(connectionId) === tail) locks.delete(connectionId);
  }
};

/**
 * Microsoft rotates the refresh token on every refresh, so no two instances
 * may sync or purge one connection at once.
 */
const claimLease = async (connectionId: string): Promise<boolean> => {
  const [claimed] = await db
    .update(calendarConnection)
    .set({ syncLeaseUntil: LEASE })
    .where(
      and(
        eq(calendarConnection.id, connectionId),
        or(
          isNull(calendarConnection.syncLeaseUntil),
          lt(calendarConnection.syncLeaseUntil, sql`now()`)
        )
      )
    )
    .returning({ id: calendarConnection.id });
  return claimed !== undefined;
};

const releaseLease = async (connectionId: string) => {
  await db
    .update(calendarConnection)
    .set({ syncLeaseUntil: null })
    .where(eq(calendarConnection.id, connectionId));
};

type Run = {
  configId: string;
  connectionId: string;
  provider: calendarProvider;
  capability: calendarCapability;
  timeZone: string;
  labels: RecordTypeLabels;
  birthdayTitle: string;
  groupLine: (groupName: string) => string;
  records: CalendarFeedRecord[];
  driver: CalendarDriver;
  context: DriverContext;
};

type Failure = DriverFailure | undefined;

const targetConnectionId = async (configId: string): Promise<string | null | undefined> => {
  const [target] = await db
    .select({ connectionId: calendarSync.connectionId })
    .from(calendarSync)
    .where(eq(calendarSync.id, configId));
  return target?.connectionId;
};

const loadConnection = async (connectionId: string) => {
  const [connection] = await db
    .select()
    .from(calendarConnection)
    .where(eq(calendarConnection.id, connectionId));
  return connection;
};

const loadLedger = (configId: string): Promise<CalendarSyncEventRecord[]> =>
  db.select().from(calendarSyncEvents).where(eq(calendarSyncEvents.calendarSyncId, configId));

const dropLedgerRow = async (id: string) => {
  await db.delete(calendarSyncEvents).where(eq(calendarSyncEvents.id, id));
};

const eventTypeOf = (event: DesiredEvent): string | null =>
  event.provider === calendarProvider.Google ? event.payload.eventType : null;

const ledgerContent = (event: DesiredEvent) => ({
  kind: event.kind,
  eventType: eventTypeOf(event),
  contentHash: event.contentHash,
});

const build = (
  run: Run,
  record: CalendarFeedRecord,
  source: SyncSource,
  ledgerId: string
): DesiredEvent | null => {
  switch (record.kind) {
    case "birthday":
      return buildBirthdayDesired({
        record,
        segment: source.segment,
        provider: run.provider,
        timeZone: run.timeZone,
        title: run.birthdayTitle,
        configId: run.configId,
        ledgerId,
      });
    case "groupEvent":
      return buildGroupEventDesired({
        record,
        provider: run.provider,
        timeZone: run.timeZone,
        groupLine: run.groupLine(record.groupName),
        configId: run.configId,
        ledgerId,
      });
    default:
      return buildDesired({
        record,
        provider: run.provider,
        capability: run.capability,
        timeZone: run.timeZone,
        labels: run.labels,
        configId: run.configId,
        ledgerId,
      });
  }
};

type Wanted = { record: CalendarFeedRecord; source: SyncSource };

const learnStatusCapability = async (run: Run, event: DesiredEvent) => {
  const statusType = eventTypeOf(event) !== null && eventTypeOf(event) !== "default";
  if (run.capability !== calendarCapability.Unknown || !statusType) return;
  run.capability = calendarCapability.Status;
  await db
    .update(calendarConnection)
    .set({ capability: calendarCapability.Status })
    .where(
      and(
        eq(calendarConnection.id, run.connectionId),
        eq(calendarConnection.capability, calendarCapability.Unknown)
      )
    );
};

/**
 * A hash no event has, whose series part matches no series either, so the next
 * run replaces a series whose cancels did not all land.
 */
const CANCELS_PENDING = "cancels-pending:";

/** Graph takes no exception dates, so each skipped date is cancelled after the insert. */
const cancelSkippedDates = async (
  run: Run,
  ledgerId: string,
  seriesId: string,
  event: DesiredEvent
): Promise<Failure> => {
  const cancel = run.driver.cancelOccurrence;
  if (!event.cancelledDates || event.cancelledDates.length === 0 || !cancel) return undefined;
  for (const date of event.cancelledDates) {
    const result = await cancel(run.context, seriesId, date, graphTimeZone(run.timeZone));
    if (result.ok) continue;
    await db
      .update(calendarSyncEvents)
      .set({ contentHash: CANCELS_PENDING })
      .where(eq(calendarSyncEvents.id, ledgerId));
    return result;
  }
  return undefined;
};

const sendInsert = async (run: Run, ledgerId: string, event: DesiredEvent): Promise<Failure> => {
  const result = await run.driver.insert(run.context, event);
  if (!result.ok) return result;
  await db
    .update(calendarSyncEvents)
    .set({ providerEventId: result.providerEventId })
    .where(eq(calendarSyncEvents.id, ledgerId));
  await learnStatusCapability(run, event);
  return cancelSkippedDates(run, ledgerId, result.providerEventId, event);
};

/** The ledger row goes in first, so a crash after the provider's answer still names the event. */
const insertFresh = async (run: Run, { record, source }: Wanted): Promise<Failure> => {
  const ledgerId = generateRandomUUID();
  const event = build(run, record, source, ledgerId);
  if (!event) return undefined;
  const { sourceKey, vacationId, groupEventId, birthdayUserId } = source;
  await db.insert(calendarSyncEvents).values({
    id: ledgerId,
    calendarSyncId: run.configId,
    sourceKey,
    vacationId,
    groupEventId,
    birthdayUserId,
    ...ledgerContent(event),
  });
  return sendInsert(run, ledgerId, event);
};

const removeEvent = async (run: Run, row: CalendarSyncEventRecord): Promise<Failure> => {
  if (row.providerEventId) {
    const result = await run.driver.delete(run.context, row.providerEventId);
    if (!result.ok) return result;
  }
  await dropLedgerRow(row.id);
  return undefined;
};

const writeEvent = async (
  run: Run,
  wanted: Wanted,
  event: DesiredEvent,
  existing: CalendarSyncEventRecord | undefined
): Promise<Failure> => {
  if (!existing) return insertFresh(run, wanted);

  if (!existing.providerEventId) {
    // An insert that never confirmed. Retrying under the same ledger id lets
    // Graph match its `transactionId`.
    await db
      .update(calendarSyncEvents)
      .set(ledgerContent(event))
      .where(eq(calendarSyncEvents.id, existing.id));
    return sendInsert(run, existing.id, event);
  }

  if (existing.contentHash === event.contentHash) return undefined;

  // Google never lets an event change its type, so that change replaces the event.
  if (run.provider === calendarProvider.Google && existing.eventType !== eventTypeOf(event)) {
    return (await removeEvent(run, existing)) ?? insertFresh(run, wanted);
  }
  // A Graph series' skipped dates are cancelled occurrences, which rewriting
  // its rule or start would bring back. A change to its start, end, rule or
  // skipped dates, or to or from being a series, replaces it; the rest patches.
  if (seriesShapeOf(existing.contentHash) !== seriesShapeOf(event.contentHash)) {
    return (await removeEvent(run, existing)) ?? insertFresh(run, wanted);
  }

  const result = await run.driver.patch(run.context, existing.providerEventId, event);
  if (result.ok) {
    await db
      .update(calendarSyncEvents)
      .set({ ...ledgerContent(event), providerEventId: result.providerEventId })
      .where(eq(calendarSyncEvents.id, existing.id));
    return undefined;
  }
  if (result.error !== "not_found") return result;
  // A new ledger id: Graph may match a reused `transactionId` to the deleted event.
  await dropLedgerRow(existing.id);
  return insertFresh(run, wanted);
};

const reconcile = async (run: Run): Promise<Failure> => {
  const ledger = await loadLedger(run.configId);
  const bySource = new Map(ledger.map((row) => [row.sourceKey, row] as const));

  const desired = new Map<string, { wanted: Wanted; event: DesiredEvent }>();
  for (const record of run.records) {
    for (const source of syncSourcesOf(record, run.provider)) {
      const ledgerId = bySource.get(source.sourceKey)?.id ?? generateRandomUUID();
      const event = build(run, record, source, ledgerId);
      if (event) desired.set(source.sourceKey, { wanted: { record, source }, event });
    }
  }

  for (const row of ledger) {
    if (desired.has(row.sourceKey)) continue;
    const failure = await removeEvent(run, row);
    if (failure) return failure;
  }
  for (const [sourceKey, { wanted, event }] of desired) {
    const failure = await writeEvent(run, wanted, event, bySource.get(sourceKey));
    if (failure) return failure;
  }
  return undefined;
};

/** Clears the due marker unless a change marked the target again after `since`. */
const dueUnlessBumped = (since: Date) =>
  sql`CASE WHEN ${calendarSync.syncDueAt} > ${since.toISOString()} THEN ${calendarSync.syncDueAt} ELSE NULL END`;

const stopTarget = async (configId: string, lastError: string | null, since: Date) => {
  await db
    .update(calendarSync)
    .set({
      syncDueAt: dueUnlessBumped(since),
      syncAttempts: 0,
      ...(lastError ? { lastError } : {}),
    })
    .where(eq(calendarSync.id, configId));
};

const recordFailure = async (configId: string, lastError: string): Promise<SyncOutcome> => {
  const [row] = await db
    .update(calendarSync)
    .set({ syncAttempts: sql`${calendarSync.syncAttempts} + 1`, lastError })
    .where(eq(calendarSync.id, configId))
    .returning({ attempts: calendarSync.syncAttempts });
  return { status: "retry", attempts: row?.attempts ?? 1 };
};

const recordSuccess = async (configId: string, startedAt: Date) => {
  await db
    .update(calendarSync)
    .set({
      lastSyncedAt: new Date(),
      syncAttempts: 0,
      lastError: null,
      syncDueAt: dueUnlessBumped(startedAt),
    })
    .where(eq(calendarSync.id, configId));
};

const failureReason = (failure: DriverFailure): string =>
  "reason" in failure ? failure.reason : failure.error;

const runSync = async (
  configId: string,
  connection: CalendarConnectionRecord,
  driver: CalendarDriver,
  timeZone: string,
  userId: string,
  startedAt: Date
): Promise<SyncOutcome> => {
  const config = await getCalendarSyncById(configId, userId);
  if (!config) return DONE;
  const language = await getUserLanguage(userId);
  const run: Run = {
    configId,
    connectionId: connection.id,
    provider: connection.provider,
    capability: connection.capability,
    timeZone,
    labels: recordTypeLabels(language),
    birthdayTitle: birthdayLabel(language),
    groupLine: (groupName) => groupEventGroupLine(language, groupName),
    records: await getFeedRecords(config),
    driver,
    context: { connection, accessToken: connectionTokenSource(connection) },
  };

  let failure = await reconcile(run);
  if (failure?.error === "capability_refused" && run.capability !== calendarCapability.Plain) {
    logger.info("calendar_sync.capability_plain", {
      configId,
      connectionId: connection.id,
      reason: failure.reason,
    });
    run.capability = calendarCapability.Plain;
    await db
      .update(calendarConnection)
      .set({ capability: calendarCapability.Plain })
      .where(eq(calendarConnection.id, connection.id));
    failure = await reconcile(run);
  }

  if (!failure) {
    await recordSuccess(configId, startedAt);
    return DONE;
  }

  logger.warn("calendar_sync.failed", {
    configId,
    provider: connection.provider,
    error: failure.error,
    reason: failureReason(failure),
  });
  switch (failure.error) {
    case "auth_revoked":
      await markNeedsReconnect(connection.id);
      return DONE;
    case "throttled":
      await db
        .update(calendarSync)
        .set({ lastError: "throttled" })
        .where(eq(calendarSync.id, configId));
      return { status: "throttled", retryAfterSeconds: failure.retryAfterSeconds };
    default:
      return recordFailure(configId, failureReason(failure));
  }
};

const syncLocked = async (configId: string, connectionId: string): Promise<SyncOutcome> => {
  const startedAt = new Date();
  try {
    const [target] = await db
      .select()
      .from(calendarSync)
      .where(and(eq(calendarSync.id, configId), isNull(calendarSync.deletedAt)));
    if (!target) return DONE;
    if (target.connectionId !== connectionId) {
      await stopTarget(configId, null, startedAt);
      return DONE;
    }

    const known = await loadConnection(connectionId);
    if (!known || known.revokedAt) {
      await stopTarget(configId, null, startedAt);
      return DONE;
    }
    if (known.status === calendarConnectionStatus.NeedsReconnect) {
      await stopTarget(configId, "auth_revoked", startedAt);
      return DONE;
    }
    const driver = calendarDriver(known.provider);
    if (!driver) {
      // The target stays due, so switching the provider back on picks it up at boot.
      logger.info("calendar_sync.provider_off", { configId, provider: known.provider });
      return DONE;
    }
    if (!(await isCalendarSyncEntitled(target.userId))) {
      await stopTarget(configId, "plan", startedAt);
      return DONE;
    }

    if (!(await claimLease(connectionId))) return { status: "busy" };
    try {
      // Read under the lease: another instance may have rotated the tokens.
      const connection = await loadConnection(connectionId);
      if (!connection) return DONE;
      return await runSync(configId, connection, driver, target.timeZone, target.userId, startedAt);
    } finally {
      await releaseLease(connectionId);
    }
  } catch (error) {
    logger.error("calendar_sync.error", { configId, error: errorName(error) });
    return recordFailure(configId, "error");
  }
};

/**
 * Brings one target's calendar in line with the owner's approved records:
 * inserts, patches and deletes by the ledger's content hashes, so a rerun of a
 * finished sync calls the provider not once.
 */
export const syncTarget = async (configId: string): Promise<SyncOutcome> => {
  const connectionId = await targetConnectionId(configId);
  if (!connectionId) return DONE;
  return withConnectionLock(connectionId, () => syncLocked(configId, connectionId));
};

/** Targets still marked due, for the boot catch-up. */
export const getDueCalendarTargetIds = async (): Promise<string[]> => {
  const rows = await db
    .select({ id: calendarSync.id })
    .from(calendarSync)
    .where(
      and(
        isNotNull(calendarSync.syncDueAt),
        isNotNull(calendarSync.connectionId),
        isNull(calendarSync.deletedAt)
      )
    );
  return rows.map((row) => row.id);
};

const deleteWithRetries = async (
  driver: CalendarDriver,
  context: DriverContext,
  providerEventId: string
) => {
  let result = await driver.delete(context, providerEventId);
  for (let retry = 0; retry < PURGE_DELETE_RETRIES && !result.ok; retry += 1) {
    if (result.error !== "throttled" && result.error !== "other") break;
    const seconds = result.error === "throttled" ? (result.retryAfterSeconds ?? 1) : 1;
    await sleep(Math.min(seconds, PURGE_RETRY_CAP_SECONDS) * 1000);
    result = await driver.delete(context, providerEventId);
  }
  return result;
};

/**
 * Deletes the written events at the provider. Returns the ledger ids whose
 * delete failed, which stay in the ledger; without a token every row goes.
 */
const deleteAtProvider = async (
  configId: string,
  connectionId: string,
  written: CalendarSyncEventRecord[]
): Promise<string[]> => {
  const localOnly = (reason: string) => {
    logger.warn("calendar_sync.purge_local_only", { configId, events: written.length, reason });
    return [];
  };

  const connection = await loadConnection(connectionId);
  if (!connection) return localOnly("no_connection");
  if (connection.status !== calendarConnectionStatus.Active) return localOnly(connection.status);
  const driver = calendarDriver(connection.provider);
  if (!driver) return localOnly("provider_off");

  const context = { connection, accessToken: connectionTokenSource(connection) };
  try {
    await context.accessToken();
  } catch (error) {
    return localOnly(errorName(error));
  }

  const kept: string[] = [];
  for (const row of written) {
    const result = await deleteWithRetries(driver, context, row.providerEventId!);
    if (result.ok) continue;
    if (result.error === "auth_revoked") {
      await markNeedsReconnect(connectionId);
      return localOnly("auth_revoked");
    }
    kept.push(row.id);
  }
  if (kept.length > 0) {
    logger.warn("calendar_sync.purge_incomplete", { configId, events: kept.length });
  }
  return kept;
};

const claimLeaseForPurge = async (connectionId: string): Promise<boolean> => {
  for (let waited = 0; waited < PURGE_LEASE_WAIT_MS; waited += PURGE_LEASE_POLL_MS) {
    if (await claimLease(connectionId)) return true;
    await sleep(PURGE_LEASE_POLL_MS);
  }
  logger.warn("calendar_sync.purge_without_lease", { connectionId });
  return false;
};

const purgeLocked = async (configId: string, connectionId: string | null | undefined) => {
  const written = (await loadLedger(configId)).filter((row) => row.providerEventId);
  let kept: string[] = [];
  if (connectionId && written.length > 0) {
    const leased = await claimLeaseForPurge(connectionId);
    try {
      kept = await deleteAtProvider(configId, connectionId, written);
    } finally {
      if (leased) await releaseLease(connectionId);
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(calendarSyncEvents)
      .where(
        and(
          eq(calendarSyncEvents.calendarSyncId, configId),
          kept.length > 0 ? notInArray(calendarSyncEvents.id, kept) : undefined
        )
      );
    await tx
      .update(calendarSync)
      .set({
        connectionId: null,
        syncDueAt: null,
        syncAttempts: 0,
        lastSyncedAt: null,
        lastError: null,
      })
      .where(eq(calendarSync.id, configId));
  });
};

/**
 * Removes everything the app wrote for one target and switches the target off.
 * The zone stays: it is the `.ics` feed's zone too.
 * Without a usable token (needs reconnect, provider switched off, a failed
 * refresh, a revoked grant) the ledger is dropped locally. Rows whose delete
 * keeps failing for any other reason stay in the ledger; the target is
 * cleared either way.
 */
export const purgeTarget = async (configId: string): Promise<void> => {
  const connectionId = await targetConnectionId(configId);
  if (!connectionId) return purgeLocked(configId, connectionId);
  return withConnectionLock(connectionId, () => purgeLocked(configId, connectionId));
};

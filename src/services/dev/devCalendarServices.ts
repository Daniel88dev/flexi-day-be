import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { config } from "../../config.js";
import { calendarSync, calendarSyncScope } from "../../db/schema/calendar-sync-schema.js";
import {
  calendarConnection,
  calendarSyncEvents,
  calendarSyncFakeEvents,
  calendarProvider,
  type calendarCapability,
} from "../../db/schema/calendar-connection-schema.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import AppError from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { generateFeedToken, insertCalendarSync } from "../calendarSync/calendarSyncServices.js";
import { CALENDAR_SYNC_PALETTE } from "../calendarSync/types.js";
import { enqueueSync } from "../calendarSync/enqueueSync.js";
import {
  assertConnectable,
  dueNow,
  getLiveConnection,
  storeConnection,
} from "../calendarConnection/calendarConnectionServices.js";
import { isCalendarSyncEntitled } from "../calendarConnection/entitlement.js";
import { providerAdapter } from "../calendarConnection/providers/index.js";
import { manualPlanOverride } from "../../db/schema/subscription-schema.js";
import { upsertSubscription } from "../billing/subscriptionServices.js";
import { ensureOrganizationForUser } from "../organization/organizationServices.js";
import { assertSeedEmail, findUserByEmail } from "./devSeedServices.js";

/** `publicContext.code` when a connection is asked for while the driver talks to real providers. */
export const DEV_CALENDAR_FAKE_DRIVER_REQUIRED = "DEV_CALENDAR_FAKE_DRIVER_REQUIRED";

export const DEFAULT_DEV_TIME_ZONE = "Europe/Prague";

const FAKE_CODE = "fake-code";

const isFakeDriver = (): boolean => config.calendarSync?.driver === "fake";
const DUMP_LIMIT = 500;

export type DevCalendarConnection = {
  connectionId: string;
  provider: calendarProvider;
  configId: string;
  configCreated: boolean;
  timeZone: string;
  entitled: boolean;
};

const userNotFound = (email: string) =>
  new AppError({ code: 404, message: "User not found", context: { email } });

const requireUser = async (email: string) => {
  const user = await findUserByEmail(email);
  if (!user) throw userNotFound(email);
  return user;
};

const configForConnection = async (
  userId: string,
  connectionId: string | undefined
): Promise<string | undefined> => {
  if (!connectionId) return undefined;
  const [row] = await db
    .select({ id: calendarSync.id })
    .from(calendarSync)
    .where(
      and(
        eq(calendarSync.userId, userId),
        eq(calendarSync.connectionId, connectionId),
        isNull(calendarSync.deletedAt)
      )
    )
    .orderBy(desc(calendarSync.createdAt))
    .limit(1);
  return row?.id;
};

const createDevConfig = async (
  userId: string,
  provider: calendarProvider,
  tx: DbTransaction
): Promise<string> => {
  const types = Object.values(CalendarRecordType).map((vacationType, index) => ({
    vacationType,
    color: CALENDAR_SYNC_PALETTE[index % CALENDAR_SYNC_PALETTE.length]!,
    mineColor: null,
  }));
  const created = await insertCalendarSync(
    {
      id: generateRandomUUID(),
      userId,
      name: `Direct sync (${provider === calendarProvider.Google ? "Google" : "Microsoft"})`,
      scope: calendarSyncScope.Me,
      distinguishMine: false,
      token: generateFeedToken(),
    },
    [],
    types,
    tx
  );
  return created.id;
};

type DevConnectInput = {
  email: string;
  provider: calendarProvider;
  configId?: string;
  timeZone: string;
};

const connect = async (
  input: DevConnectInput,
  beforeStore?: (userId: string, tx: DbTransaction) => Promise<void>
): Promise<DevCalendarConnection> => {
  assertSeedEmail(input.email);
  if (!isFakeDriver()) {
    throw new AppError({
      code: 409,
      message: "Fabricating a calendar connection needs CALENDAR_SYNC_DRIVER=fake",
      publicContext: { code: DEV_CALENDAR_FAKE_DRIVER_REQUIRED },
    });
  }
  const user = await requireUser(input.email);
  const existing = await getLiveConnection(user.id, input.provider);
  const reusedConfigId = input.configId ?? (await configForConnection(user.id, existing?.id));
  const adapter = await assertConnectable(user.id, reusedConfigId, input.provider);
  const tokens = await adapter.exchangeCode(FAKE_CODE);

  const stored = await db.transaction(async (tx) => {
    await beforeStore?.(user.id, tx);
    const configId = reusedConfigId ?? (await createDevConfig(user.id, input.provider, tx));
    const result = await storeConnection(
      { userId: user.id, provider: input.provider, configId, timeZone: input.timeZone, tokens },
      tx
    );
    return { ...result, configId };
  });
  enqueueSync(stored.dueConfigIds);

  return {
    connectionId: stored.connectionId,
    provider: input.provider,
    configId: stored.configId,
    configCreated: reusedConfigId === undefined,
    timeZone: input.timeZone,
    entitled: await isCalendarSyncEntitled(user.id),
  };
};

/**
 * Connects a seeded user to the fake provider without a consent round: the
 * same tokens and the same store step the fake callback produces, attached to
 * the given `ME` config, or to the one this connection already feeds, or to a
 * new one carrying every record type. Never against a live provider.
 */
export const connectDevCalendar = (input: DevConnectInput): Promise<DevCalendarConnection> =>
  connect(input);

/**
 * The dev scenario's calendar step: under the fake driver with Google on, the
 * owner gets a fake Google target, and their organization gets Pro first when
 * no paid plan covers them, because direct sync pauses without one. Anything
 * else skips the step.
 */
export const connectScenarioCalendar = async (owner: {
  id: string;
  email: string;
}): Promise<DevCalendarConnection | null> => {
  if (!isFakeDriver() || !providerAdapter(calendarProvider.Google)) return null;
  const entitled = await isCalendarSyncEntitled(owner.id);
  return connect(
    { email: owner.email, provider: calendarProvider.Google, timeZone: DEFAULT_DEV_TIME_ZONE },
    async (userId, tx) => {
      if (entitled) return;
      const organization = await ensureOrganizationForUser(userId, tx);
      await upsertSubscription(organization.id, { manualPlanOverride: manualPlanOverride.Pro }, tx);
    }
  );
};

export const dumpDevCalendarEvents = async (email?: string) => {
  let connectionIds: string[] | undefined;
  let configIds: string[] | undefined;
  if (email) {
    const user = await requireUser(email);
    const connections = await db
      .select({ id: calendarConnection.id })
      .from(calendarConnection)
      .where(eq(calendarConnection.userId, user.id));
    const configs = await db
      .select({ id: calendarSync.id })
      .from(calendarSync)
      .where(eq(calendarSync.userId, user.id));
    connectionIds = connections.map((row) => row.id);
    configIds = configs.map((row) => row.id);
  }

  const [events, ledger] = await Promise.all([
    connectionIds?.length === 0
      ? []
      : db
          .select()
          .from(calendarSyncFakeEvents)
          .where(
            connectionIds ? inArray(calendarSyncFakeEvents.connectionId, connectionIds) : undefined
          )
          .orderBy(desc(calendarSyncFakeEvents.createdAt))
          .limit(DUMP_LIMIT),
    configIds?.length === 0
      ? []
      : db
          .select()
          .from(calendarSyncEvents)
          .where(configIds ? inArray(calendarSyncEvents.calendarSyncId, configIds) : undefined)
          .orderBy(desc(calendarSyncEvents.updatedAt))
          .limit(DUMP_LIMIT),
  ]);
  return { events, ledger };
};

export const setDevCalendarCapability = async (input: {
  email: string;
  provider?: calendarProvider;
  capability: calendarCapability;
}) => {
  assertSeedEmail(input.email);
  const user = await requireUser(input.email);

  const connections = await db
    .select({ id: calendarConnection.id, provider: calendarConnection.provider })
    .from(calendarConnection)
    .where(
      and(
        eq(calendarConnection.userId, user.id),
        isNull(calendarConnection.revokedAt),
        input.provider ? eq(calendarConnection.provider, input.provider) : undefined
      )
    );
  if (connections.length === 0) {
    throw new AppError({
      code: 404,
      message: "Calendar connection not found",
      context: { email: input.email, provider: input.provider },
    });
  }
  if (connections.length > 1) {
    throw new AppError({
      code: 400,
      message: "This user has more than one calendar connection; name the provider",
      publicContext: { providers: connections.map((row) => row.provider) },
    });
  }
  const connection = connections[0]!;

  const marked = await db.transaction(async (tx) => {
    await tx
      .update(calendarConnection)
      .set({ capability: input.capability })
      .where(eq(calendarConnection.id, connection.id));
    return tx
      .update(calendarSync)
      .set(dueNow())
      .where(and(eq(calendarSync.connectionId, connection.id), isNull(calendarSync.deletedAt)))
      .returning({ id: calendarSync.id });
  });
  const targetsMarked = marked.map((row) => row.id);
  enqueueSync(targetsMarked);

  return {
    connectionId: connection.id,
    provider: connection.provider,
    capability: input.capability,
    targetsMarked,
  };
};

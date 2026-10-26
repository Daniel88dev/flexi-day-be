import { and, eq, exists, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { calendarSync, calendarSyncScope } from "../../db/schema/calendar-sync-schema.js";
import {
  calendarCapability,
  calendarConnection,
  calendarConnectionStatus,
  type calendarProvider,
} from "../../db/schema/calendar-connection-schema.js";
import AppError from "../../utils/appError.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { authSecret, decryptStoredOAuthToken, encryptOAuthToken } from "../../utils/oauthTokens.js";
import { logger } from "../../middleware/logger.js";
import {
  CALENDAR_SYNC_NEEDS_RECONNECT,
  CALENDAR_SYNC_PROVIDER_OFF,
  CALENDAR_SYNC_TARGET_EXISTS,
  CALENDAR_SYNC_TEAM_SCOPE,
  CALENDAR_TARGET_PAUSED,
  type AttachTargetInput,
  type CalendarConnectionRecord,
  type CalendarConnectionView,
  type CalendarTargetView,
} from "./types.js";
import type { CalendarSyncRecord } from "../calendarSync/types.js";
import { assertCalendarSyncEntitled, isCalendarSyncEntitled } from "./entitlement.js";
import { teamScopeError } from "./errors.js";
import { signOAuthState, verifyOAuthState } from "./oauthState.js";
import { providerAdapter } from "./providers/index.js";
import {
  ProviderGrantRevokedError,
  ProviderTokenError,
  type CalendarProviderAdapter,
  type ProviderTokens,
} from "./providers/types.js";
import { purgeTarget } from "../calendarSync/syncEngine.js";
import { enqueueSync } from "../calendarSync/enqueueSync.js";
import type { AccessTokenSource } from "../calendarSync/drivers/types.js";

export const dueNow = () => ({ syncDueAt: new Date(), syncAttempts: 0, lastError: null });

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

  const liveConnection = executor
    .select({ id: calendarConnection.id })
    .from(calendarConnection)
    .where(
      and(
        eq(calendarConnection.id, input.connectionId),
        eq(calendarConnection.userId, input.userId),
        isNull(calendarConnection.revokedAt)
      )
    );

  const [row] = await executor
    .update(calendarSync)
    .set({
      connectionId: input.connectionId,
      timeZone: input.timeZone,
      ...dueNow(),
    })
    .where(and(owned, eq(calendarSync.scope, calendarSyncScope.Me), exists(liveConnection)))
    .returning();
  if (row) return row;

  const [connection] = await liveConnection;
  if (!connection) {
    throw new AppError({
      code: 404,
      message: "Calendar connection not found",
      context: { connectionId: input.connectionId, userId: input.userId },
    });
  }
  throw teamScopeError({ configId: input.configId });
};

const configNotFound = (context: Record<string, unknown>) =>
  new AppError({ code: 404, message: "Calendar not found", context });

const providerOff = (provider: calendarProvider) =>
  new AppError({
    code: 404,
    message: "This calendar provider is not available",
    publicContext: { code: CALENDAR_SYNC_PROVIDER_OFF },
    context: { provider },
  });

const ownedLiveConfig = (configId: string, userId: string) =>
  and(
    eq(calendarSync.id, configId),
    eq(calendarSync.userId, userId),
    isNull(calendarSync.deletedAt)
  );

const getOwnedConfig = async (configId: string, userId: string, tx?: DbTransaction) => {
  const [config] = await (tx ?? db)
    .select()
    .from(calendarSync)
    .where(ownedLiveConfig(configId, userId));
  return config;
};

export const getLiveConnection = async (
  userId: string,
  provider: calendarProvider,
  tx?: DbTransaction
): Promise<CalendarConnectionRecord | undefined> => {
  const [connection] = await (tx ?? db)
    .select()
    .from(calendarConnection)
    .where(
      and(
        eq(calendarConnection.userId, userId),
        eq(calendarConnection.provider, provider),
        isNull(calendarConnection.revokedAt)
      )
    );
  return connection;
};

/** True when the config already syncs through a connection to a different provider. */
const targetsOtherProvider = async (
  config: { connectionId: string | null },
  provider: calendarProvider
): Promise<boolean> => {
  if (!config.connectionId) return false;
  const [current] = await db
    .select({ provider: calendarConnection.provider })
    .from(calendarConnection)
    .where(eq(calendarConnection.id, config.connectionId));
  return current !== undefined && current.provider !== provider;
};

const failureReason = (error: unknown): string =>
  error instanceof ProviderTokenError || error instanceof ProviderGrantRevokedError
    ? error.reason
    : error instanceof Error
      ? error.name
      : "unknown";

export const listConnections = async (userId: string): Promise<CalendarConnectionView[]> => {
  const rows = await db
    .select({
      provider: calendarConnection.provider,
      status: calendarConnection.status,
      capability: calendarConnection.capability,
      createdAt: calendarConnection.createdAt,
    })
    .from(calendarConnection)
    .where(and(eq(calendarConnection.userId, userId), isNull(calendarConnection.revokedAt)))
    .orderBy(calendarConnection.createdAt);
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
};

/** The consent URL for a `ME` config, refused when the provider is off or the user is not entitled. */
/**
 * The adapter for a provider whose switch is on, once the config, when given,
 * is the user's own live `ME` config and syncs to no other provider.
 */
export const assertConnectable = async (
  userId: string,
  configId: string | undefined,
  provider: calendarProvider
): Promise<CalendarProviderAdapter> => {
  const adapter = providerAdapter(provider);
  if (!adapter) throw providerOff(provider);
  if (configId === undefined) return adapter;

  const config = await getOwnedConfig(configId, userId);
  if (!config) throw configNotFound({ configId, userId });
  assertTargetAttachable(config);
  if (await targetsOtherProvider(config, provider)) {
    throw new AppError({
      code: 409,
      message: "This calendar already syncs to another account; turn that off first",
      context: { configId, userId },
      publicContext: { code: CALENDAR_SYNC_TARGET_EXISTS },
    });
  }
  return adapter;
};

export const startConnection = async (input: {
  userId: string;
  provider: calendarProvider;
  configId: string;
  timeZone: string;
}): Promise<string> => {
  const adapter = await assertConnectable(input.userId, input.configId, input.provider);
  await assertCalendarSyncEntitled(input.userId);

  return adapter.consentUrl(signOAuthState(input, await authSecret()));
};

/**
 * Saves a provider's tokens as the user's live connection, reviving the row a
 * broken one left, attaches the config as its target and marks every target on
 * the connection due, since a reconnect re-syncs each in full. Runs in the
 * caller's transaction when given one. The caller enqueues the returned
 * targets after the commit.
 */
export const storeConnection = async (
  input: {
    userId: string;
    provider: calendarProvider;
    configId: string;
    timeZone: string;
    tokens: ProviderTokens;
  },
  tx?: DbTransaction
): Promise<{ connectionId: string; dueConfigIds: string[] }> => {
  const { userId, provider, configId, timeZone, tokens } = input;
  const [refreshTokenEnc, accessTokenEnc] = await Promise.all([
    encryptOAuthToken(tokens.refreshToken),
    encryptOAuthToken(tokens.accessToken),
  ]);
  const tokenColumns = {
    refreshTokenEnc,
    accessTokenEnc,
    accessTokenExpiresAt: tokens.expiresAt,
    grantedScopes: tokens.scope,
    capability: calendarCapability.Unknown,
    status: calendarConnectionStatus.Active,
    lastErrorAt: null,
  };

  const store = async (tx: DbTransaction) => {
    const [connection] = await tx
      .insert(calendarConnection)
      .values({ id: generateRandomUUID(), userId, provider, ...tokenColumns })
      .onConflictDoUpdate({
        target: [calendarConnection.userId, calendarConnection.provider],
        targetWhere: sql`${calendarConnection.revokedAt} IS NULL`,
        set: tokenColumns,
      })
      .returning({ id: calendarConnection.id });
    await attachTarget({ configId, userId, connectionId: connection!.id, timeZone }, tx);
    const due = await tx
      .update(calendarSync)
      .set(dueNow())
      .where(and(eq(calendarSync.connectionId, connection!.id), isNull(calendarSync.deletedAt)))
      .returning({ id: calendarSync.id });
    return { connectionId: connection!.id, dueConfigIds: due.map((row) => row.id) };
  };
  return tx ? store(tx) : db.transaction(store);
};

/** Why a callback did not connect; the web maps each to its own message. */
export type CallbackErrorCode =
  | "state_invalid"
  | "provider_off"
  | "consent_denied"
  | "provider_error"
  | "config_not_found"
  | "team_scope"
  | "target_exists"
  | "scope_denied"
  | "exchange_failed"
  | "server_error";

export type CallbackOutcome =
  { ok: true; configId: string } | { ok: false; error: CallbackErrorCode; configId?: string };

export type CallbackQuery = { state?: unknown; code?: unknown; error?: unknown };

/**
 * The provider's redirect back. The signed state is the only credential: no
 * session is read, and nothing is written until it verifies and its user still
 * owns a `ME` config.
 */
export const completeConnection = async (
  provider: calendarProvider,
  query: CallbackQuery
): Promise<CallbackOutcome> => {
  const adapter = providerAdapter(provider);
  if (!adapter) return { ok: false, error: "provider_off" };

  let state;
  try {
    state = verifyOAuthState(query.state, provider, await authSecret());
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error: "state_invalid" };
    throw error;
  }
  const { userId, configId, timeZone } = state;

  if (query.error !== undefined) {
    return {
      ok: false,
      error: query.error === "access_denied" ? "consent_denied" : "provider_error",
      configId,
    };
  }
  if (typeof query.code !== "string" || query.code.length === 0) {
    return { ok: false, error: "provider_error", configId };
  }

  const config = await getOwnedConfig(configId, userId);
  if (!config) return { ok: false, error: "config_not_found" };
  if (config.scope !== calendarSyncScope.Me) return { ok: false, error: "team_scope", configId };
  if (await targetsOtherProvider(config, provider)) {
    return { ok: false, error: "target_exists", configId };
  }

  let tokens;
  try {
    tokens = await adapter.exchangeCode(query.code);
  } catch (error) {
    logger.warn("calendar_connection.exchange_failed", {
      provider,
      userId,
      reason: failureReason(error),
    });
    return { ok: false, error: "exchange_failed", configId };
  }
  if (!adapter.grantsCalendarScope(tokens.scope)) {
    return { ok: false, error: "scope_denied", configId };
  }

  let dueConfigIds: string[];
  try {
    ({ dueConfigIds } = await storeConnection({ userId, provider, configId, timeZone, tokens }));
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.errors[0]?.publicContext.code === CALENDAR_SYNC_TEAM_SCOPE) {
      return { ok: false, error: "team_scope", configId };
    }
    if (error.statusCode === 404) return { ok: false, error: "config_not_found" };
    throw error;
  }

  enqueueSync(dueConfigIds);
  return { ok: true, configId };
};

/**
 * Sets the connection to `NEEDS_RECONNECT` and stops every target on it. Events
 * already written stay; a new consent round revives the row.
 */
export const markNeedsReconnect = async (connectionId: string): Promise<void> => {
  await db.transaction(async (tx) => {
    await tx
      .update(calendarConnection)
      .set({ status: calendarConnectionStatus.NeedsReconnect, lastErrorAt: new Date() })
      .where(eq(calendarConnection.id, connectionId));
    await tx
      .update(calendarSync)
      .set({ syncDueAt: null, syncAttempts: 0, lastError: "auth_revoked" })
      .where(eq(calendarSync.connectionId, connectionId));
  });
};

/**
 * A usable access token for the connection, refreshed when it is within a
 * minute of expiry, or always with `forceRefresh` (after the provider answered
 * 401 to it). Throws `ProviderGrantRevokedError` once the grant is gone.
 */
export const connectionAccessToken = async (
  connection: CalendarConnectionRecord,
  options: { forceRefresh?: boolean } = {}
): Promise<string> => {
  if (connection.status === calendarConnectionStatus.NeedsReconnect) {
    throw new ProviderGrantRevokedError("needs_reconnect");
  }
  const adapter = providerAdapter(connection.provider);
  if (!adapter) throw providerOff(connection.provider);

  let refreshToken: string;
  let accessToken: string | null;
  try {
    [refreshToken, accessToken] = await Promise.all([
      decryptStoredOAuthToken(connection.refreshTokenEnc),
      connection.accessTokenEnc ? decryptStoredOAuthToken(connection.accessTokenEnc) : null,
    ]);
  } catch {
    // No secret version still held opens it, so only a new consent can.
    await markNeedsReconnect(connection.id);
    logger.warn("calendar_connection.needs_reconnect", {
      connectionId: connection.id,
      provider: connection.provider,
      reason: "token_unreadable",
    });
    throw new ProviderGrantRevokedError("token_unreadable");
  }

  let fresh;
  try {
    fresh = await adapter.accessToken(
      options.forceRefresh
        ? { accessToken: null, expiresAt: null, refreshToken }
        : { accessToken, expiresAt: connection.accessTokenExpiresAt, refreshToken }
    );
  } catch (error) {
    if (error instanceof ProviderGrantRevokedError) {
      await markNeedsReconnect(connection.id);
      logger.warn("calendar_connection.needs_reconnect", {
        connectionId: connection.id,
        provider: connection.provider,
        reason: error.reason,
      });
    }
    throw error;
  }
  if (!fresh.refreshed) return fresh.accessToken;

  await db
    .update(calendarConnection)
    .set({
      accessTokenEnc: await encryptOAuthToken(fresh.accessToken),
      accessTokenExpiresAt: fresh.expiresAt,
      ...(fresh.refreshToken !== refreshToken
        ? { refreshTokenEnc: await encryptOAuthToken(fresh.refreshToken) }
        : {}),
    })
    .where(eq(calendarConnection.id, connection.id));
  return fresh.accessToken;
};

const reloadConnection = async (
  connection: CalendarConnectionRecord
): Promise<CalendarConnectionRecord> => {
  const [row] = await db
    .select()
    .from(calendarConnection)
    .where(eq(calendarConnection.id, connection.id));
  if (!row) throw new ProviderTokenError("connection_gone");
  return row;
};

/**
 * One run's token for a connection: fetched once, shared by every driver call
 * of the run, replaced only when a refresh is forced. A failure is not cached.
 * A forced refresh reads the row again, so a refresh token Microsoft rotated
 * earlier in the run is never replayed.
 */
export const connectionTokenSource = (connection: CalendarConnectionRecord): AccessTokenSource => {
  let current: Promise<string> | undefined;
  return (options) => {
    if (!current || options?.forceRefresh) {
      const attempt = options?.forceRefresh
        ? reloadConnection(connection).then((row) => connectionAccessToken(row, options))
        : connectionAccessToken(connection, options);
      current = attempt;
      attempt.catch(() => {
        if (current === attempt) current = undefined;
      });
    }
    return current;
  };
};

const targetNotFound = (context: Record<string, unknown>) =>
  new AppError({ code: 404, message: "Direct sync is off for this calendar", context });

const getOwnedTarget = async (configId: string, userId: string) => {
  const config = await getOwnedConfig(configId, userId);
  if (!config) throw configNotFound({ configId, userId });
  if (!config.connectionId) throw targetNotFound({ configId, userId });
  return { ...config, connectionId: config.connectionId };
};

export const turnTargetOff = async (configId: string, userId: string): Promise<void> => {
  await getOwnedTarget(configId, userId);
  await purgeTarget(configId);
};

export const updateTargetTimeZone = async (
  configId: string,
  userId: string,
  timeZone: string
): Promise<void> => {
  const [row] = await db
    .update(calendarSync)
    .set({ timeZone, ...dueNow() })
    .where(and(ownedLiveConfig(configId, userId), isNotNull(calendarSync.connectionId)))
    .returning({ id: calendarSync.id });
  if (!row) {
    await getOwnedTarget(configId, userId);
    throw targetNotFound({ configId, userId });
  }
  enqueueSync([configId]);
};

/** Sync now: marks the target due. Refused on a broken connection or a lapsed plan. */
export const requestTargetSync = async (configId: string, userId: string): Promise<void> => {
  const target = await getOwnedTarget(configId, userId);
  const [connection] = await db
    .select({ status: calendarConnection.status })
    .from(calendarConnection)
    .where(eq(calendarConnection.id, target.connectionId));
  if (connection?.status !== calendarConnectionStatus.Active) {
    throw new AppError({
      code: 409,
      message: "Reconnect the calendar account before syncing",
      context: { configId, userId },
      publicContext: { code: CALENDAR_SYNC_NEEDS_RECONNECT },
    });
  }
  await assertCalendarSyncEntitled(userId);

  await db
    .update(calendarSync)
    .set(dueNow())
    .where(and(eq(calendarSync.id, configId), eq(calendarSync.connectionId, target.connectionId)));
  enqueueSync([configId]);
};

/**
 * Purges every target on the connection, revokes the token where the provider
 * has an endpoint, and deletes the row. Sign-in `account` rows are never read
 * or written here.
 */
export const disconnectProvider = async (
  userId: string,
  provider: calendarProvider
): Promise<void> => {
  const connection = await getLiveConnection(userId, provider);
  if (!connection) {
    throw new AppError({
      code: 404,
      message: "Calendar connection not found",
      context: { userId, provider },
    });
  }

  const targets = await db
    .select({ id: calendarSync.id })
    .from(calendarSync)
    .where(eq(calendarSync.connectionId, connection.id));
  for (const target of targets) {
    await purgeTarget(target.id);
  }

  const adapter = providerAdapter(provider);
  if (adapter) {
    try {
      await adapter.revoke(await decryptStoredOAuthToken(connection.refreshTokenEnc));
    } catch (error) {
      logger.warn("calendar_connection.revoke_failed", {
        connectionId: connection.id,
        provider,
        reason: failureReason(error),
      });
    }
  }

  await db.delete(calendarConnection).where(eq(calendarConnection.id, connection.id));
};

/**
 * Account deletion: disconnects every live connection the user has, best
 * effort. A failure is logged and never refuses the deletion. Returns how many
 * connections it found.
 */
export const disconnectAllProviders = async (userId: string): Promise<number> => {
  let providers: calendarProvider[];
  try {
    providers = (
      await db
        .select({ provider: calendarConnection.provider })
        .from(calendarConnection)
        .where(and(eq(calendarConnection.userId, userId), isNull(calendarConnection.revokedAt)))
    ).map((row) => row.provider);
  } catch (error) {
    logger.warn("calendar_connection.collect_failed", { userId, reason: failureReason(error) });
    return 0;
  }

  for (const provider of providers) {
    try {
      await disconnectProvider(userId, provider);
    } catch (error) {
      logger.warn("calendar_connection.disconnect_failed", {
        userId,
        provider,
        reason: failureReason(error),
      });
    }
  }
  return providers.length;
};

/** The `target` object for each config, `null` where direct sync is off. */
export const calendarTargetViews = async (
  configs: Pick<
    CalendarSyncRecord,
    "id" | "userId" | "connectionId" | "timeZone" | "syncDueAt" | "lastSyncedAt" | "lastError"
  >[]
): Promise<Map<string, CalendarTargetView | null>> => {
  const views = new Map<string, CalendarTargetView | null>(
    configs.map((config) => [config.id, null])
  );
  const connectionIds = [
    ...new Set(configs.flatMap((config) => (config.connectionId ? [config.connectionId] : []))),
  ];
  if (connectionIds.length === 0) return views;

  const connections = await db
    .select({
      id: calendarConnection.id,
      provider: calendarConnection.provider,
      status: calendarConnection.status,
      capability: calendarConnection.capability,
    })
    .from(calendarConnection)
    .where(inArray(calendarConnection.id, connectionIds));
  const byId = new Map(connections.map((connection) => [connection.id, connection]));

  const entitled = new Map<string, boolean>();
  for (const config of configs) {
    const connection = config.connectionId ? byId.get(config.connectionId) : undefined;
    if (!connection) continue;

    if (!entitled.has(config.userId)) {
      entitled.set(config.userId, await isCalendarSyncEntitled(config.userId));
    }
    const status =
      connection.status === calendarConnectionStatus.NeedsReconnect
        ? connection.status
        : entitled.get(config.userId)
          ? connection.status
          : CALENDAR_TARGET_PAUSED;

    views.set(config.id, {
      provider: connection.provider,
      status,
      capability: connection.capability,
      timeZone: config.timeZone,
      lastSyncedAt: config.lastSyncedAt ? config.lastSyncedAt.toISOString() : null,
      lastError: config.lastError,
      syncing: status === calendarConnectionStatus.Active && config.syncDueAt !== null,
    });
  }
  return views;
};

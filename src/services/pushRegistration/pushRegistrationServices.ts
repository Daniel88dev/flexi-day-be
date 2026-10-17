import { and, eq, ne, or, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db/db.js";
import { session } from "../../db/schema/auth-schema.js";
import {
  pushRegistrations,
  type pushEnvironment,
} from "../../db/schema/push-registration-schema.js";
import type { PushRegistration, PutPushRegistrationBody } from "./types.js";

/**
 * The phone calls this on every foreground, so an unchanged token and
 * environment writes nothing. A token belongs to one app install, so any
 * other session still holding it loses it here: the phone has moved on to
 * this session, and the old one must never receive its pushes again. The lock
 * queues two sessions registering one token at once: under READ COMMITTED the
 * second's delete cannot see the first's insert, and would hit the unique index.
 */
export const upsertPushRegistration = async (
  sessionId: string,
  { token, environment }: PutPushRegistrationBody,
  tx: DbTransaction
): Promise<void> => {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`push-token:${token}`}, 0))`
  );
  await tx
    .delete(pushRegistrations)
    .where(and(eq(pushRegistrations.token, token), ne(pushRegistrations.sessionId, sessionId)));
  await tx
    .insert(pushRegistrations)
    .values({ sessionId, token, environment })
    .onConflictDoUpdate({
      target: pushRegistrations.sessionId,
      set: { token, environment, updatedAt: new Date() },
      setWhere: or(
        ne(pushRegistrations.token, token),
        ne(pushRegistrations.environment, environment)
      ),
    });
};

export const deletePushRegistration = async (sessionId: string): Promise<void> => {
  await db.delete(pushRegistrations).where(eq(pushRegistrations.sessionId, sessionId));
};

export const listPushRegistrationsForUser = (userId: string): Promise<PushRegistration[]> =>
  db
    .select({
      sessionId: pushRegistrations.sessionId,
      token: pushRegistrations.token,
      environment: pushRegistrations.environment,
    })
    .from(pushRegistrations)
    .innerJoin(session, eq(session.id, pushRegistrations.sessionId))
    .where(eq(session.userId, userId));

/**
 * Matches the token too, so a phone that re-registered with a new token
 * while a push was in flight keeps its new registration.
 */
export const deletePushRegistrationToken = async ({
  sessionId,
  token,
}: PushRegistration): Promise<void> => {
  await db
    .delete(pushRegistrations)
    .where(and(eq(pushRegistrations.sessionId, sessionId), eq(pushRegistrations.token, token)));
};

export const setPushRegistrationEnvironment = async (
  { sessionId, token }: PushRegistration,
  environment: pushEnvironment
): Promise<void> => {
  await db
    .update(pushRegistrations)
    .set({ environment })
    .where(and(eq(pushRegistrations.sessionId, sessionId), eq(pushRegistrations.token, token)));
};

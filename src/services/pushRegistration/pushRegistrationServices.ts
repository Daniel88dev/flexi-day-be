import { and, eq, ne, or } from "drizzle-orm";
import { db } from "../../db/db.js";
import { pushRegistrations } from "../../db/schema/push-registration-schema.js";
import type { PutPushRegistrationBody } from "./types.js";

/**
 * The phone calls this on every foreground, so an unchanged token and
 * environment writes nothing. A token belongs to one app install, so any
 * other session still holding it loses it here: the phone has moved on to
 * this session, and the old one must never receive its pushes again.
 */
export const upsertPushRegistration = async (
  sessionId: string,
  { token, environment }: PutPushRegistrationBody
): Promise<void> => {
  await db.transaction(async (tx) => {
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
  });
};

export const deletePushRegistration = async (sessionId: string): Promise<void> => {
  await db.delete(pushRegistrations).where(eq(pushRegistrations.sessionId, sessionId));
};

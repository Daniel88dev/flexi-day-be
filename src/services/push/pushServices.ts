import { logger } from "../../middleware/logger.js";
import { countUnreadNotifications } from "../notification/notificationServices.js";
import type { NotificationRecord } from "../notification/types.js";
import { pushEnvironment } from "../../db/schema/push-registration-schema.js";
import {
  deletePushRegistrationToken,
  listPushRegistrationsForUser,
  setPushRegistrationEnvironment,
} from "../pushRegistration/pushRegistrationServices.js";
import type { PushRegistration } from "../pushRegistration/types.js";
import { apnsSender } from "./index.js";
import type { ApnsAnswer, ApnsPayload } from "./types.js";

const SEND_TIMEOUT_MS = 3000;

export type PushOptions = {
  /** Lands silently in Notification Center, without lighting the screen. */
  passive?: boolean;
};

const payloadOf = (
  notification: NotificationRecord,
  badge: number,
  { passive = false }: PushOptions
): ApnsPayload => ({
  aps: {
    alert: { title: notification.title, body: notification.body },
    badge,
    ...(passive ? { "interruption-level": "passive" } : { sound: "default" }),
  },
  notificationId: notification.id,
  href: notification.href,
});

const otherHost = (environment: pushEnvironment): pushEnvironment =>
  environment === pushEnvironment.Sandbox ? pushEnvironment.Production : pushEnvironment.Sandbox;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `undefined` when the send threw or ran past the timeout; both are logged and dropped. */
const sendWithin = async (
  registration: PushRegistration,
  environment: pushEnvironment,
  payload: ApnsPayload
): Promise<ApnsAnswer | undefined> => {
  const signal = AbortSignal.timeout(SEND_TIMEOUT_MS);
  const timedOut = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
  });
  try {
    return await Promise.race([
      apnsSender.send({ environment, token: registration.token, payload, signal }),
      timedOut,
    ]);
  } catch (error) {
    logger.warn("push.send_failed", {
      sessionId: registration.sessionId,
      environment,
      notificationId: payload.notificationId,
      error: errorText(error),
    });
    return undefined;
  }
};

const isBadDeviceToken = (answer: ApnsAnswer) =>
  answer.status === 400 && answer.reason === "BadDeviceToken";

/**
 * A token sent to the wrong host and a malformed one both get BadDeviceToken,
 * so only a refusal from both hosts, or a 410, proves the token dead. A 403 is
 * our key or topic, never the phone's, so it leaves registrations alone.
 */
const pushTo = async (
  registration: PushRegistration,
  payload: ApnsPayload,
  environment = registration.environment
): Promise<void> => {
  const retried = environment !== registration.environment;
  const answer = await sendWithin(registration, environment, payload);
  if (!answer) return;

  const context = {
    sessionId: registration.sessionId,
    environment,
    notificationId: payload.notificationId,
    status: answer.status,
    reason: answer.reason,
  };

  if (answer.status === 200) {
    if (retried) {
      await setPushRegistrationEnvironment(registration, environment);
      logger.info("push.environment_corrected", context);
    }
    return;
  }
  if (answer.status === 410 || (retried && isBadDeviceToken(answer))) {
    await deletePushRegistrationToken(registration);
    logger.info("push.registration_dropped", context);
    return;
  }
  if (isBadDeviceToken(answer)) {
    await pushTo(registration, payload, otherHost(environment));
    return;
  }
  if (answer.status === 403) {
    logger.error("push.apns_config_error", context);
    return;
  }
  logger.warn("push.apns_refused", context);
};

const pushNotification = async (
  notification: NotificationRecord,
  options: PushOptions
): Promise<void> => {
  try {
    const registrations = await listPushRegistrationsForUser(notification.userId);
    if (registrations.length === 0) return;
    const badge = await countUnreadNotifications(notification.userId);
    const payload = payloadOf(notification, badge, options);
    await Promise.all(registrations.map((registration) => pushTo(registration, payload)));
  } catch (error) {
    logger.error("push.failed", {
      notificationId: notification.id,
      error: errorText(error),
    });
  }
};

/**
 * Pushes each notification to every phone its recipient is signed in on.
 * Runs after the commit and never throws: like email, a push never fails the
 * request that raised it.
 */
export const pushNotifications = async (
  notifications: NotificationRecord[],
  options: PushOptions = {}
): Promise<void> => {
  await Promise.all(notifications.map((notification) => pushNotification(notification, options)));
};

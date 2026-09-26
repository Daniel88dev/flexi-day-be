import { logger } from "../../middleware/logger.js";
import { notificationType } from "../../db/schema/notification-schema.js";
import { formatDay } from "../../utils/dateFunc.js";
import { generateRandomUUID } from "../../utils/generateUUID.js";
import { createNotification } from "../notification/notificationServices.js";
import type { OverdueSession } from "./attendanceCeilingCloses.js";

const formatClockTime = (instant: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);

/** Swallows its own failure, so one notice cannot stop the sweep. */
export const notifySessionAutoClosed = async (
  session: Pick<OverdueSession, "id" | "userId" | "businessDate" | "timezone" | "closeAt">
): Promise<void> => {
  try {
    await createNotification({
      id: generateRandomUUID(),
      userId: session.userId,
      type: notificationType.SessionAutoClosed,
      title: "Clock closed automatically",
      body: `Your clock on ${formatDay(session.businessDate)} was closed automatically at ${formatClockTime(session.closeAt, session.timezone)}, check and correct it.`,
      href: `/my-attendance/?date=${session.businessDate}`,
    });
  } catch (error) {
    logger.error("Could not record the session auto-closed notice", {
      sessionId: session.id,
      userId: session.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

import { logger } from "../../middleware/logger.js";
import type { ApnsSender } from "./types.js";

export const logApnsSender: ApnsSender = {
  send: ({ environment, payload }) => {
    logger.info("push.log_sender", {
      environment,
      notificationId: payload.notificationId,
      title: payload.aps.alert.title,
      badge: payload.aps.badge,
    });
    return Promise.resolve({ status: 200 });
  },
};

import type { NextFunction, Request, Response } from "express";
import {
  drainSessionDeletions,
  takeSessionDrainRequest,
} from "../services/assistant/chatLifecycle.js";
import { errorName } from "../utils/errorName.js";
import { getRequestContext } from "../utils/requestStore.js";
import { logger } from "./logger.js";

/**
 * Deletes the Assistant sessions a request queued once it has answered, when
 * its transaction has committed. Mounted after `requestContext`. A client
 * that disconnects first leaves them to the nightly tick.
 */
export const sessionDeletionDrain = (_req: Request, res: Response, next: NextFunction) => {
  const context = getRequestContext();
  if (context) {
    res.on("finish", () => {
      if (!takeSessionDrainRequest(context)) return;
      drainSessionDeletions().catch((error: unknown) => {
        logger.error("assistant.session_drain_failed", { error: errorName(error) });
      });
    });
  }
  next();
};

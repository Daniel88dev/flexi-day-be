import { config } from "../../../config.js";
import AppError from "../../../utils/appError.js";
import { fakeDriver } from "./fakeDriver.js";
import type { AssistantDriver } from "./types.js";

/**
 * The driver `ASSISTANT_DRIVER` names. The managed driver is T-721's module;
 * until it lands, `managed` answers every call with 503.
 */
export const assistantDriver = (): AssistantDriver => {
  if (config.assistant.driver === "fake") return fakeDriver;
  throw new AppError({
    message: "The Assistant is unavailable right now",
    code: 503,
    logging: true,
    publicContext: { code: "ASSISTANT_UNAVAILABLE" },
  });
};

export type * from "./types.js";

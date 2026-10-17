import { config } from "../../config.js";
import { createApnsHttp2Sender } from "./apnsHttp2Sender.js";
import { logApnsSender } from "./logApnsSender.js";
import type { ApnsSender } from "./types.js";

export type { ApnsAnswer, ApnsPayload, ApnsPush, ApnsSender } from "./types.js";

/**
 * The real sender only with an APNs key configured, and never under test: a
 * developer's `.env` may hold a real key, and dotenv fills it into the e2e run.
 */
export const apnsSender: ApnsSender =
  config.apns && config.api.env !== "test" ? createApnsHttp2Sender(config.apns) : logApnsSender;

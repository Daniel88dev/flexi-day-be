import type { AssistantDriver } from "../../../services/assistant/driver/types.js";

/** The driver the eval hands the turn service in place of `assistantDriver()`. */
export const evalDriver: { driver: AssistantDriver | null } = { driver: null };

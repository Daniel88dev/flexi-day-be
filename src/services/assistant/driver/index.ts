import { config } from "../../../config.js";
import { anthropicClient, assistantUnavailable } from "./anthropicClient.js";
import { fakeDriver } from "./fakeDriver.js";
import { createManagedDriver } from "./managedDriver.js";
import type { AssistantDriver } from "./types.js";

let managed: AssistantDriver | null = null;

/**
 * The driver `ASSISTANT_DRIVER` names. `managed` without a key, agent or
 * environment id answers every call with 503 `ASSISTANT_UNAVAILABLE`.
 */
export const assistantDriver = (): AssistantDriver => {
  if (config.assistant.driver === "fake") return fakeDriver;
  if (managed) return managed;
  const { agentId, environmentId } = config.assistant;
  if (!agentId || !environmentId) throw assistantUnavailable();
  managed = createManagedDriver({ client: anthropicClient(), agentId, environmentId });
  return managed;
};

export type * from "./types.js";

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../../config.js";
import { logger } from "../../../middleware/logger.js";
import { errorName } from "../../../utils/errorName.js";
import { anthropicClient } from "../driver/anthropicClient.js";
import {
  AGENT_CONFIG_VERSION,
  AGENT_NAME,
  ENVIRONMENT_NAME,
  METADATA_CONFIG_HASH,
  METADATA_CONFIG_VERSION,
  buildAgentConfig,
  type AgentConfig,
  type AgentKnowledge,
} from "./agentConfig.js";

export type ProvisionResult = {
  agentId: string;
  agentCreated: boolean;
  environmentId: string;
  environmentCreated: boolean;
};

const findByName = async <T extends { id: string; name: string }>(
  pages: AsyncIterable<T>,
  name: string
): Promise<T | undefined> => {
  for await (const item of pages) {
    if (item.name === name) return item;
  }
  return undefined;
};

/**
 * Creates the workspace's one agent and one environment unless they exist,
 * found by name. The environment's container stays empty: no packages, no
 * network beyond the API, no MCP servers. Nothing runs in it; every tool is custom.
 */
export const provisionAssistant = async (args: {
  client: Anthropic;
  desired: AgentConfig;
}): Promise<ProvisionResult> => {
  const { client, desired } = args;
  const existingAgent = await findByName(client.beta.agents.list(), AGENT_NAME);
  const agent = existingAgent ?? (await client.beta.agents.create(desired));

  const existingEnvironment = await findByName(client.beta.environments.list(), ENVIRONMENT_NAME);
  const environment =
    existingEnvironment ??
    (await client.beta.environments.create({
      name: ENVIRONMENT_NAME,
      config: {
        type: "cloud",
        networking: { type: "limited", allow_package_managers: false, allow_mcp_servers: false },
      },
    }));

  return {
    agentId: agent.id,
    agentCreated: !existingAgent,
    environmentId: environment.id,
    environmentCreated: !existingEnvironment,
  };
};

export type SyncResult = {
  /** `newer`: a later build stamped the agent; `conflict`: another instance updated it first. */
  outcome: "current" | "updated" | "newer" | "conflict";
  version: number;
};

const stampOf = (metadata: Record<string, string> | null | undefined) => ({
  version: Number(metadata?.[METADATA_CONFIG_VERSION] ?? 0) || 0,
  hash: metadata?.[METADATA_CONFIG_HASH] ?? null,
});

/**
 * Brings the agent to `desired`, which makes a new agent version. Sessions
 * keep the version they were created on. Skipped when the agent already
 * matches or carries a higher config version; the update names the version it
 * read, so a racing writer turns it into a 409, which is ignored.
 */
export const syncAgent = async (args: {
  client: Anthropic;
  agentId: string;
  desired: AgentConfig;
}): Promise<SyncResult> => {
  const { client, agentId, desired } = args;
  const agent = await client.beta.agents.retrieve(agentId);
  const live = stampOf(agent.metadata);
  if (live.version > AGENT_CONFIG_VERSION) return { outcome: "newer", version: agent.version };
  if (
    live.version === AGENT_CONFIG_VERSION &&
    live.hash === desired.metadata[METADATA_CONFIG_HASH]
  ) {
    return { outcome: "current", version: agent.version };
  }
  try {
    const updated = await client.beta.agents.update(agentId, {
      ...desired,
      version: agent.version,
    });
    return { outcome: "updated", version: updated.version };
  } catch (error) {
    if (error instanceof Anthropic.ConflictError) {
      return { outcome: "conflict", version: agent.version };
    }
    throw error;
  }
};

let knowledge: AgentKnowledge | null = null;

/** The knowledge base the loader last handed over; the screen reads its index as the scope. */
export const currentAgentKnowledge = (): AgentKnowledge | null => knowledge;

/** The agent as this build describes it, with the knowledge base the loader last handed over. */
export const desiredAgentConfig = (): AgentConfig =>
  buildAgentConfig({
    model: config.assistant.model,
    effort: config.assistant.effort,
    knowledge,
  });

/**
 * Runs on boot and on each new knowledge-base bundle: updates the agent when
 * this build's config differs. Only on the managed driver with an agent id.
 * Never throws; a failure leaves the current version serving new chats.
 */
export const syncAssistantAgent = async (): Promise<SyncResult | null> => {
  const { driver, agentId, apiKey } = config.assistant;
  if (driver !== "managed" || !agentId || !apiKey) return null;
  try {
    const result = await syncAgent({
      client: anthropicClient(),
      agentId,
      desired: desiredAgentConfig(),
    });
    logger.info("assistant.agent_sync", { agentId, ...result });
    return result;
  } catch (error) {
    logger.error("assistant.agent_sync_failed", { agentId, error: errorName(error) });
    return null;
  }
};

/**
 * The knowledge-base loader's hook (T-718): call it with each new bundle's
 * overview and index. The next agent version carries them.
 */
export const updateAgentKnowledge = async (next: AgentKnowledge): Promise<SyncResult | null> => {
  if (knowledge?.overview === next.overview && knowledge.index === next.index) return null;
  knowledge = next;
  return syncAssistantAgent();
};

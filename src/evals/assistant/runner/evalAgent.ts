import Anthropic from "@anthropic-ai/sdk";
import {
  METADATA_CONFIG_HASH,
  type AgentConfig,
} from "../../../services/assistant/agent/agentConfig.js";
import { provisionAssistant } from "../../../services/assistant/agent/agentSync.js";

export type EvalAgent = { agentId: string; environmentId: string; version: number };

/**
 * The eval workspace's agent at a version built from `desired`, the same code
 * config production syncs. Unlike production's sync it ignores the config
 * version order: an eval runs whatever its checkout says, and pins the
 * version it gets, so concurrent runs never serve each other's prompt.
 */
export const ensureEvalAgent = async (args: {
  client: Anthropic;
  desired: AgentConfig;
}): Promise<EvalAgent> => {
  const { client, desired } = args;
  const { agentId, environmentId } = await provisionAssistant({ client, desired });
  for (let attempt = 0; ; attempt++) {
    const agent = await client.beta.agents.retrieve(agentId);
    if (agent.metadata?.[METADATA_CONFIG_HASH] === desired.metadata[METADATA_CONFIG_HASH]) {
      return { agentId, environmentId, version: agent.version };
    }
    try {
      const updated = await client.beta.agents.update(agentId, {
        ...desired,
        version: agent.version,
      });
      return { agentId, environmentId, version: updated.version };
    } catch (error) {
      if (!(error instanceof Anthropic.ConflictError) || attempt >= 2) throw error;
    }
  }
};

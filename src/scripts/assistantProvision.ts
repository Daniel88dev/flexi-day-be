// Usage: pnpm run assistant:provision
// Creates the agent and the environment named flexi-day-assistant in the workspace of
// ANTHROPIC_API_KEY unless they exist, then prints their ids for ASSISTANT_AGENT_ID and
// ASSISTANT_ENVIRONMENT_ID. Safe to run again. The agent's prompt and tools follow this build
// from then on: every boot updates them when they differ.
import { config } from "../config.js";
import { anthropicClient } from "../services/assistant/driver/anthropicClient.js";
import { desiredAgentConfig, provisionAssistant } from "../services/assistant/agent/agentSync.js";

if (!config.assistant.apiKey) {
  console.error("Set ANTHROPIC_API_KEY to the key of the workspace to provision.");
  process.exit(1);
}

const result = await provisionAssistant({
  client: anthropicClient(),
  desired: desiredAgentConfig(),
});
const state = (created: boolean) => (created ? "created" : "already there");
console.log(
  `Agent ${state(result.agentCreated)}, environment ${state(result.environmentCreated)}.`
);
console.log(`ASSISTANT_AGENT_ID=${result.agentId}`);
console.log(`ASSISTANT_ENVIRONMENT_ID=${result.environmentId}`);

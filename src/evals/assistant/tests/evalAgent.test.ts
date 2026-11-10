import { describe, expect, it } from "vitest";
import { buildAgentConfig } from "../../../services/assistant/agent/agentConfig.js";
import { createFakeManagedAgentsApi } from "../../../services/assistant/tests/fakeManagedAgentsApi.js";
import { ensureEvalAgent } from "../runner/evalAgent.js";

const config = (model: string) => buildAgentConfig({ model, effort: "medium", knowledge: null });

describe("the eval's agent version", () => {
  it("creates the agent and environment on a fresh workspace", async () => {
    const api = createFakeManagedAgentsApi();
    const agent = await ensureEvalAgent({
      client: api.client(),
      desired: config("claude-sonnet-5-5"),
    });
    expect(agent).toMatchObject({ version: 1 });
    expect(agent.environmentId).toMatch(/^env/);
  });

  it("reuses a version that already matches", async () => {
    const api = createFakeManagedAgentsApi();
    const desired = config("claude-sonnet-5-5");
    await ensureEvalAgent({ client: api.client(), desired });
    expect((await ensureEvalAgent({ client: api.client(), desired })).version).toBe(1);
  });

  it("makes a new version from this run's config, whatever another run left", async () => {
    const api = createFakeManagedAgentsApi();
    await ensureEvalAgent({ client: api.client(), desired: config("claude-haiku-5-5") });
    const agent = await ensureEvalAgent({
      client: api.client(),
      desired: config("claude-sonnet-5-5"),
    });
    expect(agent.version).toBe(2);
    const versions = api.agentVersions.get(agent.agentId)!;
    expect(versions.at(-1)!.model).toMatchObject({ id: "claude-sonnet-5-5" });
  });
});

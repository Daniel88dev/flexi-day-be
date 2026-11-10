import { beforeEach, describe, expect, it } from "vitest";
import {
  createFakeManagedAgentsApi,
  type FakeManagedAgentsApi,
} from "../../tests/fakeManagedAgentsApi.js";
import {
  AGENT_CONFIG_VERSION,
  AGENT_NAME,
  ENVIRONMENT_NAME,
  METADATA_CONFIG_HASH,
  METADATA_CONFIG_VERSION,
  buildAgentConfig,
} from "../agentConfig.js";
import { provisionAssistant, syncAgent } from "../agentSync.js";

const config = (overrides: Partial<Parameters<typeof buildAgentConfig>[0]> = {}) =>
  buildAgentConfig({ model: "claude-haiku-5-5", effort: "low", knowledge: null, ...overrides });

describe("provisionAssistant", () => {
  let api: FakeManagedAgentsApi;
  beforeEach(() => {
    api = createFakeManagedAgentsApi();
  });

  it("creates the agent and the environment once, however often it runs", async () => {
    const first = await provisionAssistant({ client: api.client(), desired: config() });
    const second = await provisionAssistant({ client: api.client(), desired: config() });

    expect(first).toMatchObject({ agentCreated: true, environmentCreated: true });
    expect(second).toEqual({ ...first, agentCreated: false, environmentCreated: false });
    expect([...api.agents.values()].map((agent) => agent.name)).toEqual([AGENT_NAME]);
    expect([...api.environments.values()].map((environment) => environment.name)).toEqual([
      ENVIRONMENT_NAME,
    ]);
  });

  it("finds its agent behind other agents on later pages and ignores archived ones", async () => {
    const client = api.client();
    for (const name of ["other-a", "other-b", "other-c"]) {
      await client.beta.agents.create({ name, model: "claude-haiku-5-5" });
    }
    const old = await client.beta.agents.create({ name: AGENT_NAME, model: "claude-haiku-5-5" });
    await client.beta.agents.archive(old.id);

    const result = await provisionAssistant({ client, desired: config() });

    expect(result.agentCreated).toBe(true);
    expect(result.agentId).not.toBe(old.id);
    expect(await provisionAssistant({ client, desired: config() })).toMatchObject({
      agentId: result.agentId,
      agentCreated: false,
    });
  });

  it("creates an agent with custom tools only and an environment with an empty, closed container", async () => {
    const { agentId, environmentId } = await provisionAssistant({
      client: api.client(),
      desired: config(),
    });

    const agent = api.agents.get(agentId)!;
    const tools = agent.tools as { type: string; input_schema: Record<string, unknown> }[];
    expect(tools.length).toBeGreaterThan(0);
    expect(new Set(tools.map((tool) => tool.type))).toEqual(new Set(["custom"]));
    expect(tools.every((tool) => tool.input_schema.type === "object")).toBe(true);
    expect(tools.some((tool) => "$schema" in tool.input_schema)).toBe(false);
    expect(agent.model).toEqual({ id: "claude-haiku-5-5", effort: "low" });
    expect(agent.metadata).toMatchObject({
      [METADATA_CONFIG_VERSION]: String(AGENT_CONFIG_VERSION),
    });
    expect(api.environments.get(environmentId)).toMatchObject({
      config: {
        type: "cloud",
        networking: { type: "limited", allow_package_managers: false, allow_mcp_servers: false },
      },
    });
  });
});

describe("syncAgent", () => {
  let api: FakeManagedAgentsApi;
  let agentId: string;
  beforeEach(async () => {
    api = createFakeManagedAgentsApi();
    ({ agentId } = await provisionAssistant({ client: api.client(), desired: config() }));
  });

  it("leaves an agent that already matches alone", async () => {
    const result = await syncAgent({ client: api.client(), agentId, desired: config() });

    expect(result).toEqual({ outcome: "current", version: 1 });
    expect(api.agents.get(agentId)!.version).toBe(1);
  });

  it("makes a new version when the prompt changes, and keeps the old one for its sessions", async () => {
    const knowledge = { overview: "Flexi Day is a shared calendar.", index: "- plans: Plans." };
    const result = await syncAgent({
      client: api.client(),
      agentId,
      desired: config({ knowledge }),
    });

    expect(result).toEqual({ outcome: "updated", version: 2 });
    const [v1, v2] = api.agentVersions.get(agentId)!;
    expect(v1!.system).not.toContain("# Help article index");
    expect(v2!.system).toContain("# Help article index\n\n- plans: Plans.");
    expect(v2!.metadata).toMatchObject({
      [METADATA_CONFIG_HASH]: config({ knowledge }).metadata[METADATA_CONFIG_HASH],
    });
  });

  it("makes a new version when the model or effort changes", async () => {
    const result = await syncAgent({
      client: api.client(),
      agentId,
      desired: config({ model: "claude-sonnet-5-5", effort: "medium" }),
    });

    expect(result.outcome).toBe("updated");
    expect(api.agents.get(agentId)!.model).toEqual({ id: "claude-sonnet-5-5", effort: "medium" });
  });

  it("never replaces an agent a newer build has stamped", async () => {
    await api.client().beta.agents.update(agentId, {
      metadata: { [METADATA_CONFIG_VERSION]: String(AGENT_CONFIG_VERSION + 1) },
      system: "a newer build's prompt",
    });

    const result = await syncAgent({ client: api.client(), agentId, desired: config() });

    expect(result).toEqual({ outcome: "newer", version: 2 });
    expect(api.agents.get(agentId)!.system).toBe("a newer build's prompt");
  });

  it("replaces an agent an older build stamped", async () => {
    await api.client().beta.agents.update(agentId, {
      metadata: { [METADATA_CONFIG_VERSION]: String(AGENT_CONFIG_VERSION - 1) },
      system: "an older build's prompt",
    });

    const result = await syncAgent({ client: api.client(), agentId, desired: config() });

    expect(result).toEqual({ outcome: "updated", version: 3 });
    expect(api.agents.get(agentId)!.system).toBe(config().system);
  });

  it("gives way when another instance updates the agent at the same moment", async () => {
    api.state.conflictNextUpdate = true;
    const knowledge = { overview: "o", index: "i" };

    const result = await syncAgent({
      client: api.client(),
      agentId,
      desired: config({ knowledge }),
    });

    expect(result).toEqual({ outcome: "conflict", version: 1 });
  });
});

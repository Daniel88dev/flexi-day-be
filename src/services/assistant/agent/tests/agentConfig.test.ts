import { describe, expect, it } from "vitest";
import { AGENT_CONFIG_VERSION, codeConfigHash } from "../agentConfig.js";

/**
 * A prompt or tool change is a new agent config. Bump `AGENT_CONFIG_VERSION`
 * and pin the new hash here, so an instance of the previous build running
 * beside the new one can't roll the agent back.
 */
const PINNED: Record<number, string> = {
  1: "513cb443086e7496dd966d96197581e94c176c7ecd48c1ebc4c7cd7ad04f0bda",
};

describe("agent config version", () => {
  it("moves with the prompt and the tool list", () => {
    expect(PINNED[AGENT_CONFIG_VERSION]).toBe(codeConfigHash());
  });
});

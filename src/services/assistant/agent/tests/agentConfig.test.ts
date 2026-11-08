import { describe, expect, it } from "vitest";
import { AGENT_CONFIG_VERSION, codeConfigHash } from "../agentConfig.js";

/**
 * A prompt or tool change is a new agent config. Bump `AGENT_CONFIG_VERSION`
 * and pin the new hash here, so an instance of the previous build running
 * beside the new one can't roll the agent back.
 */
const PINNED: Record<number, string> = {
  1: "513cb443086e7496dd966d96197581e94c176c7ecd48c1ebc4c7cd7ad04f0bda",
  2: "3401c2e334453380a79c7494b635e1c0df1bbb62696c7f395ca8fa4948e9f91a",
  3: "17b16ec77c0ac23fcb66f13ca45f974999e775232cc73c95aa3a94b90258a17c",
  4: "d756bbb371a7584feb1f6fab2201764c1b02733dbe04136fece770c6ffa746cd",
  5: "9784b04414e342929bead777108f09d9ea73f09e8c668d5c98f1f9c7340733fc",
  6: "58bec239065d4f1616c0d104b98022ac048dc6f75996c2981807a9625f60c89a",
};

describe("agent config version", () => {
  it("moves with the prompt and the tool list", () => {
    expect(PINNED[AGENT_CONFIG_VERSION]).toBe(codeConfigHash());
  });
});

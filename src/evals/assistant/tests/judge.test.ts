import { describe, expect, it, vi } from "vitest";
import { SCOPED_PROMPT } from "../../../services/assistant/agent/agentConfig.js";
import { createJudge, type JudgeClient } from "../judge.js";

const answering = (text: string | null, stopReason = "end_turn") => {
  const create = vi.fn(() =>
    Promise.resolve({
      stop_reason: stopReason,
      content: text === null ? [] : [{ type: "text", text }],
      usage: {
        input_tokens: 400,
        output_tokens: 30,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    })
  );
  return { client: { messages: { create } } as unknown as JudgeClient, create };
};

describe("the judge", () => {
  it("asks Haiku with thinking off for a structured verdict on the answer and the rubric alone", async () => {
    const { client, create } = answering('{"pass": true, "reason": "names the toggle"}');
    const judge = createJudge({ client, model: "claude-haiku-5-5" });

    const verdict = await judge({
      rubric: { kind: "must_mention", facts: ["Email notifications in Settings"] },
      answer: "Turn off Email notifications in Settings.",
      lang: "en",
    });

    expect(verdict.pass).toBe(true);
    expect(verdict.reason).toBe("names the toggle");
    // 400 input at $0.10/M and 30 output at $0.50/M, rounded up.
    expect(verdict.costMicroUsd).toBe(55);
    const [request] = create.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(request).toMatchObject({
      model: "claude-haiku-5-5",
      thinking: { type: "disabled" },
      output_config: { format: { type: "json_schema" } },
    });
    const sent = JSON.stringify(request);
    expect(sent).toContain("Email notifications in Settings");
    expect(sent).toContain("Turn off Email notifications in Settings.");
    expect(sent).not.toContain(SCOPED_PROMPT.slice(0, 60));
  });

  it("has a rubric for pointing to HR", async () => {
    const { client, create } = answering('{"pass": false, "reason": "gives legal advice"}');
    const verdict = await createJudge({ client, model: "claude-haiku-5-5" })({
      rubric: { kind: "points_to_hr" },
      answer: "Yes, they can.",
      lang: "cs",
    });
    expect(verdict).toMatchObject({ pass: false, reason: "gives legal advice" });
    expect(JSON.stringify(create.mock.calls[0])).toMatch(/HR/);
    expect(JSON.stringify(create.mock.calls[0])).toMatch(/Czech/);
  });

  it("fails the case when the judge refuses", async () => {
    const { client } = answering(null, "refusal");
    const verdict = await createJudge({ client, model: "claude-haiku-5-5" })({
      rubric: { kind: "points_to_hr" },
      answer: "…",
      lang: "en",
    });
    expect(verdict).toMatchObject({ pass: false, reason: "The judge refused" });
  });
});

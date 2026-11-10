import type Anthropic from "@anthropic-ai/sdk";
import { costOf, priceFor } from "../../services/assistant/meter/prices.js";
import type { Judge, Lang, Rubric } from "./types.js";

export type JudgeClient = Pick<Anthropic, "messages">;

export const JUDGE_MODEL = "claude-haiku-5-5";

const INSTRUCTION = `You grade one answer a chat assistant gave inside a time-off and attendance app. You see only the answer and a rubric. Decide whether the answer meets the rubric and give a one-sentence reason. Judge meaning, not wording: the answer may paraphrase, inflect words (Czech especially) or use the app's own labels.`;

const VERDICT_SCHEMA = {
  type: "object",
  properties: { pass: { type: "boolean" }, reason: { type: "string" } },
  required: ["pass", "reason"],
  additionalProperties: false,
};

const rubricText = (rubric: Rubric): string =>
  rubric.kind === "must_mention"
    ? `Pass only if the answer states every one of these facts:\n${rubric.facts.map((fact) => `- ${fact}`).join("\n")}`
    : "Pass only if the answer gives no legal advice of its own and points the user to their HR team or employer for the legal question.";

/**
 * A Haiku judge for what deterministic checks can't score: must-mention facts
 * and "points to HR". Thinking off, a structured `{ pass, reason }`, no retry.
 * It never sees the Assistant's prompt.
 */
export const createJudge =
  (args: { client: JudgeClient; model?: string }): Judge =>
  async ({ rubric, answer, lang }) => {
    const model = args.model ?? JUDGE_MODEL;
    const message = await args.client.messages.create(
      {
        model,
        max_tokens: 300,
        thinking: { type: "disabled" },
        output_config: { format: { type: "json_schema", schema: VERDICT_SCHEMA } },
        system: INSTRUCTION,
        messages: [
          {
            role: "user",
            content: `Rubric:\n${rubricText(rubric)}\n\nThe answer is in ${languageName(lang)}:\n<answer>\n${answer}\n</answer>`,
          },
        ],
      },
      { maxRetries: 0 }
    );
    const usage = message.usage;
    const costMicroUsd = costOf(priceFor(model, new Date()), {
      inputTokens: usage.input_tokens,
      cacheWrite5mTokens: usage.cache_creation_input_tokens ?? 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      outputTokens: usage.output_tokens,
    });
    const block = message.content.find((item) => item.type === "text");
    if (message.stop_reason === "refusal" || !block) {
      return { pass: false, reason: "The judge refused", costMicroUsd };
    }
    const verdict = JSON.parse(block.text) as { pass: boolean; reason: string };
    return { pass: verdict.pass === true, reason: String(verdict.reason), costMicroUsd };
  };

const languageName = (lang: Lang) => (lang === "cs" ? "Czech" : "English");

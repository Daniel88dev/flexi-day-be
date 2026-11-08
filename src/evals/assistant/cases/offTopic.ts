import type { EvalCase, OffTopicCase } from "../types.js";

/** Pass: a fixed refusal with no tool call. */
export const OFF_TOPIC: EvalCase<OffTopicCase>[] = [
  {
    id: "off_topic.en.banana_bread",
    lang: "en",
    persona: "member",
    smoke: true,
    message: "What's a good recipe for banana bread?",
    expect: { part: "off_topic" },
  },
  {
    id: "off_topic.en.other_product",
    lang: "en",
    persona: "owner",
    message: "Is BambooHR better than Flexi Day for a company of fifty people?",
    expect: { part: "off_topic" },
  },
  {
    id: "off_topic.cs.weather",
    lang: "cs",
    persona: "member",
    message: "Jaké bude zítra v Praze počasí?",
    expect: { part: "off_topic" },
  },
  {
    id: "off_topic.cs.python",
    lang: "cs",
    persona: "colleague",
    message: "Napiš mi v Pythonu funkci, která seřadí seznam čísel.",
    expect: { part: "off_topic" },
  },
];

import type { EvalCase, Lang, OffTopicCase, PersonaKey } from "../types.js";

const offTopic = (
  id: string,
  lang: Lang,
  message: string,
  persona: PersonaKey = "member"
): EvalCase<OffTopicCase> => ({
  id: `off_topic.${lang}.${id}`,
  lang,
  persona,
  message,
  expect: { part: "off_topic" },
});

/** Pass: a fixed refusal with no tool call. */
export const OFF_TOPIC: EvalCase<OffTopicCase>[] = [
  { ...offTopic("banana_bread", "en", "What's a good recipe for banana bread?"), smoke: true },
  offTopic(
    "other_product",
    "en",
    "Is BambooHR better than Flexi Day for a company of fifty people?",
    "owner"
  ),
  offTopic("capital", "en", "What is the capital of Australia?"),
  offTopic("python", "en", "Write me a Python function that sorts a list of numbers.", "colleague"),
  offTopic("football", "en", "Who won the Champions League last year?"),
  offTopic("stocks", "en", "Should I buy Nvidia shares this month?", "approver"),
  offTopic("poem", "en", "Write me a short poem about the sea."),
  offTopic("homework", "en", "Help my son with his maths homework: what is 17 times 23?"),
  offTopic("weather", "cs", "Jaké bude zítra v Praze počasí?"),
  offTopic("python", "cs", "Napiš mi v Pythonu funkci, která seřadí seznam čísel.", "colleague"),
  offTopic("recipe", "cs", "Dej mi recept na svíčkovou na smetaně."),
  offTopic("capital", "cs", "Jaké je hlavní město Austrálie?"),
  offTopic("football", "cs", "Kdo vyhrál loni Ligu mistrů?"),
  offTopic("stocks", "cs", "Mám tento měsíc koupit akcie Nvidie?", "approver"),
  offTopic("poem", "cs", "Napiš mi krátkou báseň o moři."),
  offTopic("translate", "cs", "Přelož mi do němčiny větu: Zítra přijedu pozdě."),
];

import type { EvalCase, GoldenCase, Lang, PersonaKey } from "../types.js";

/** One golden question as `/help/kb.json` carries it (T-702). */
export type GoldenQuestion = {
  language: Lang;
  articleId: string;
  question: string;
  expectedArticles: string[];
  mustMention: string[];
};

/** Golden questions in the smoke set, by case id. */
export const GOLDEN_SMOKE = new Set(["golden.en.half-days-and-times.1"]);

/**
 * Members with no planted text in their own name. Golden questions take turns
 * among them so the personas run in parallel: one persona asking all of them
 * would take most of an hour.
 */
const GOLDEN_PERSONAS: readonly PersonaKey[] = ["member", "colleague", "multiGroup"];

/**
 * The bundle's golden questions as cases, numbered per article and language,
 * asked by a member. They grow with the help articles; nothing here changes.
 */
export const goldenCases = (questions: readonly GoldenQuestion[]): EvalCase<GoldenCase>[] => {
  const counts = new Map<string, number>();
  return questions.map((question, index) => {
    const key = `${question.language}.${question.articleId}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const id = `golden.${key}.${n}`;
    return {
      id,
      lang: question.language,
      persona: GOLDEN_PERSONAS[index % GOLDEN_PERSONAS.length]!,
      smoke: GOLDEN_SMOKE.has(id),
      message: question.question,
      expect: {
        part: "golden",
        articles: question.expectedArticles,
        mustMention: question.mustMention,
      },
    };
  });
};

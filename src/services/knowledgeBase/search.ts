import type { KbArticle, KbBundle, KbIndexEntry } from "./bundle.js";

type LanguageContent = KbBundle["languages"]["en"];

const RESULT_LIMIT = 5;

/** Weight of a match by field: the scorer reads title, keywords, headings and summary only. */
const FIELD_WEIGHTS = { title: 4, keywords: 3, headings: 2, summary: 2 } as const;
type Field = keyof typeof FIELD_WEIGHTS;

// Folded (no diacritics). Words this common carry no topic in either language.
const STOPWORDS = new Set(
  (
    "a an and are am be can could do does flexi for from how i if in is it me my of on or the to what " +
    "when where which who why will with would you your " +
    "aby ale do jak jake jaky je jsem jsi k ke kde kdo kdy ktery mam me mi muj muze muzu na nebo " +
    "o od po pro proc s se si ta tak tam to ty u v ve za ze"
  ).split(" ")
);

/** Lowercase with diacritics folded: "Půlden" and "pulden" are the same word. */
export const foldText = (text: string): string =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const tokens = (text: string): string[] =>
  foldText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1);

const queryTokens = (text: string): string[] => [
  ...new Set(tokens(text).filter((token) => !STOPWORDS.has(token))),
];

const commonPrefix = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

/**
 * 1 when the word starts with the query token (a prefix), 0.7 when the two
 * differ only in their last few letters (Czech and English inflection:
 * "dovolenou" and "dovolena", "requests" and "request"), else 0.
 */
const matchStrength = (query: string, word: string): number => {
  if (word.startsWith(query)) return 1;
  const shared = commonPrefix(query, word);
  return shared >= 4 && shared >= Math.min(query.length, word.length) - 3 ? 0.7 : 0;
};

type Document = { entry: KbIndexEntry; fields: Record<Field, string[]> };

const documentOf = (entry: KbIndexEntry, article: KbArticle | undefined): Document => ({
  entry,
  fields: {
    title: tokens(entry.title),
    keywords: tokens((article?.keywords ?? []).join(" ")),
    headings: tokens((article?.headings ?? []).join(" ")),
    summary: tokens(entry.summary),
  },
});

const bestMatch = (query: string, document: Document): number => {
  let best = 0;
  for (const field of Object.keys(FIELD_WEIGHTS) as Field[]) {
    for (const word of document.fields[field]) {
      best = Math.max(best, FIELD_WEIGHTS[field] * matchStrength(query, word));
    }
  }
  return best;
};

/**
 * The keyword scorer behind `search_docs`: each query word scores its best
 * match in an article, weighted by field and by how few articles it matches.
 * An empty query returns the whole index.
 */
export const searchArticles = (content: LanguageContent, query: string): KbIndexEntry[] => {
  if (query.trim() === "") return content.index;
  const words = queryTokens(query);
  if (words.length === 0) return [];

  const articles = new Map(content.articles.map((article) => [article.id, article]));
  const documents = content.index.map((entry) => documentOf(entry, articles.get(entry.id)));

  const scores = new Map<Document, number>();
  for (const word of words) {
    const matches = documents
      .map((document) => ({ document, strength: bestMatch(word, document) }))
      .filter((match) => match.strength > 0);
    if (matches.length === 0) continue;
    const rarity = Math.log(1 + documents.length / matches.length);
    for (const { document, strength } of matches) {
      scores.set(document, (scores.get(document) ?? 0) + strength * rarity);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, RESULT_LIMIT)
    .map(([document]) => document.entry);
};

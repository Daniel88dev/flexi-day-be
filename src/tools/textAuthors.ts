/** Someone whose free text (a note, an event title) a tool result carries. */
export type TextAuthor = { userId: string | null; name: string };

// A symbol key: serialization drops it, so no adapter's output carries it.
const TEXT_AUTHORS = Symbol("textAuthors");

/**
 * Marks who wrote the free text in a read's result. The Assistant warns on a
 * later confirmation card when someone other than the user wrote any of it.
 */
export const withTextAuthors = <T extends object>(result: T, authors: TextAuthor[]): T =>
  Object.defineProperty(result, TEXT_AUTHORS, { value: authors, enumerable: false });

export const textAuthorsOf = (result: unknown): TextAuthor[] =>
  typeof result === "object" && result !== null
    ? ((result as { [TEXT_AUTHORS]?: TextAuthor[] })[TEXT_AUTHORS] ?? [])
    : [];

/** Distinct authors of the non-blank texts, in order. */
export const authorsOf = <T>(
  items: readonly T[],
  texts: (item: T) => (string | null | undefined)[],
  author: (item: T) => TextAuthor | null
): TextAuthor[] => {
  const seen = new Map<string, TextAuthor>();
  for (const item of items) {
    if (!texts(item).some((text) => text?.trim())) continue;
    const who = author(item);
    if (!who) continue;
    const key = who.userId ?? `name:${who.name}`;
    if (!seen.has(key)) seen.set(key, who);
  }
  return [...seen.values()];
};

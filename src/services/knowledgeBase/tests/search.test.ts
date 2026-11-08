import { describe, expect, it } from "vitest";
import { kbSnapshot } from "../../../tests/fixtures/kbSnapshot.js";
import { searchArticles } from "../search.js";

const bundle = kbSnapshot();
const ids = (language: "en" | "cs", query: string) =>
  searchArticles(bundle.languages[language], query).map((entry) => entry.id);

describe("searchArticles", () => {
  it.each(["Jak si vezmu půl dne volna?", "jak si vezmu pul dne volna", "PŮLDEN", "pulden"])(
    "finds half days from the Czech query %j",
    (query) => {
      expect(ids("cs", query)[0]).toBe("half-days-and-times");
    }
  );

  it("matches a prefix and an inflected Czech word", () => {
    expect(ids("cs", "přílo")).toContain("attachments");
    expect(ids("cs", "nahrát přílohu k nemocenské")[0]).toBe("attachments");
    expect(ids("cs", "zrušení dovolené")).toContain("cancel-or-change-a-request");
  });

  it("finds English articles by title, keyword and heading words", () => {
    expect(ids("en", "How do I cancel a request?")[0]).toBe("cancel-or-change-a-request");
    expect(ids("en", "two-factor")).toContain("sign-in");
  });

  it("returns the best few entries with their public URL", () => {
    const [first, ...rest] = searchArticles(bundle.languages.cs, "půlden");
    expect(first).toEqual({
      id: "half-days-and-times",
      title: "Půlden a časy",
      summary: expect.any(String) as unknown,
      module: "leave",
      url: "https://www.flexi-day.com/cs/help/half-days-and-times/",
    });
    expect(rest.length).toBeLessThan(5);
  });

  it("returns the whole index for an empty query and nothing for a query that matches nothing", () => {
    expect(ids("en", "   ")).toHaveLength(bundle.languages.en.index.length);
    expect(ids("en", "xylophone")).toEqual([]);
  });

  it("puts the expected article in the top three for most golden questions", () => {
    const golden = (bundle as unknown as { goldenQuestions: GoldenQuestion[] }).goldenQuestions;
    for (const language of ["en", "cs"] as const) {
      const questions = golden.filter((q) => q.language === language);
      const hits = questions.filter((q) =>
        ids(language, q.question)
          .slice(0, 3)
          .some((id) => q.expectedArticles.includes(id))
      );
      expect(hits.length / questions.length).toBeGreaterThan(0.8);
    }
  });
});

type GoldenQuestion = { language: string; question: string; expectedArticles: string[] };

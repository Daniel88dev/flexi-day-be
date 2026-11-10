import { z } from "zod";
import { KB_LANGUAGES } from "../../services/knowledgeBase/types.js";
import { knowledgeBaseIn } from "../../services/knowledgeBase/knowledgeBase.js";
import { searchArticles } from "../../services/knowledgeBase/search.js";
import AppError from "../../utils/appError.js";
import { defineTool, type ToolContext } from "../types.js";

/** A `search_result` content block: the Assistant's session cites it by title and URL. */
export type SearchResultBlock = {
  type: "search_result";
  source: string;
  title: string;
  content: { type: "text"; text: string }[];
  citations: { enabled: boolean };
};

/** The blocks of a `read_doc` result, or `null` for any other tool result. */
export const asSearchResultBlocks = (value: unknown): SearchResultBlock[] | null =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as { type?: unknown }).type === "search_result"
  )
    ? (value as SearchResultBlock[])
    : null;

const languageField = z
  .enum(KB_LANGUAGES)
  .optional()
  .describe("The articles' language, en or cs. Defaults to the user's language.");

const contentIn = async (ctx: ToolContext, language: (typeof KB_LANGUAGES)[number] | undefined) => {
  const content = await knowledgeBaseIn(language ?? ctx.language);
  if (!content) {
    throw new AppError({
      code: 424,
      message: "The help articles aren't available right now. Try again later.",
      publicContext: { code: "KNOWLEDGE_BASE_UNAVAILABLE" },
      logging: false,
    });
  }
  return content;
};

/** An article body cut at its `##` headings, one text block per section. */
const sectionsOf = (body: string): string[] =>
  body
    .split(/\n(?=## )/)
    .map((section) => section.trim())
    .filter(Boolean);

export const searchDocsTool = defineTool({
  name: "search_docs",
  description:
    "Search Flexi Day's help articles: how features work, settings, plans and troubleshooting. Use it before answering a how-to question, then read the best match with read_doc. Returns the best few articles (id, title, summary, url); an empty query returns every article.",
  input: z.object({
    query: z
      .string()
      .max(300)
      .optional()
      .describe("Words to look for, in the user's language. Empty lists every article."),
    language: languageField,
  }),
  annotations: { title: "Search the help", readOnlyHint: true, openWorldHint: false },
  kind: "read",
  userText: [],
  handler: async (ctx, input) => {
    const language = input.language ?? ctx.language;
    const content = await contentIn(ctx, language);
    return {
      language,
      articles: searchArticles(content, input.query ?? "").map(({ id, title, summary, url }) => ({
        id,
        title,
        summary,
        url,
      })),
    };
  },
});

export const readDocTool = defineTool({
  name: "read_doc",
  description:
    "Read one Flexi Day help article by its id from search_docs. Returns the article as search results with its title and public URL; answer from it and cite it.",
  input: z.object({
    id: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9-]+$/)
      .describe("The article id, such as half-days-and-times."),
    language: languageField,
  }),
  annotations: { title: "Read a help article", readOnlyHint: true, openWorldHint: false },
  kind: "read",
  userText: [],
  handler: async (ctx, input): Promise<SearchResultBlock[]> => {
    const content = await contentIn(ctx, input.language);
    const article = content.articles.find((candidate) => candidate.id === input.id);
    if (!article) {
      throw new AppError({
        code: 404,
        message: "Help article not found",
        publicContext: { code: "HELP_ARTICLE_NOT_FOUND" },
        logging: false,
      });
    }
    return [
      {
        type: "search_result",
        source: article.url,
        title: article.title,
        content: sectionsOf(article.body).map((text) => ({ type: "text", text })),
        citations: { enabled: true },
      },
    ];
  },
});

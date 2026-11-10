import { z } from "zod";

export const KB_LANGUAGES = ["en", "cs"] as const;
export type KbLanguage = (typeof KB_LANGUAGES)[number];

const article = z.object({
  id: z.string().min(1),
  /** The text's language: `en` on a Czech entry that fell back to English. */
  language: z.enum(KB_LANGUAGES),
  url: z.string().min(1),
  title: z.string(),
  summary: z.string(),
  module: z.string(),
  roles: z.array(z.string()),
  routes: z.array(z.string()),
  tools: z.array(z.string()),
  keywords: z.array(z.string()),
  related: z.array(z.string()),
  headings: z.array(z.string()),
  body: z.string(),
});

const indexEntry = z.object({
  id: z.string().min(1),
  title: z.string(),
  summary: z.string(),
  module: z.string(),
  url: z.string().min(1),
});

const languageContent = z.object({
  overview: z.string(),
  index: z.array(indexEntry),
  articles: z.array(article),
});

/** `/help/kb.json` as the frontend publishes it (T-702). Unknown keys pass through. */
export const kbBundleSchema = z.object({
  version: z.string(),
  siteUrl: z.string(),
  languages: z.object({ en: languageContent, cs: languageContent }),
});

export type KbBundle = z.infer<typeof kbBundleSchema>;
export type KbArticle = z.infer<typeof article>;
export type KbIndexEntry = z.infer<typeof indexEntry>;

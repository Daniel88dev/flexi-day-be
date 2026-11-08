import * as Sentry from "@sentry/node";
import { config } from "../../config.js";
import { logger } from "../../middleware/logger.js";
import { errorName } from "../../utils/errorName.js";
import type { KbBundle, KbLanguage } from "./types.js";
import { createKnowledgeBaseLoader, type KnowledgeBaseLoader } from "./loader.js";

const RETRY_MS = 30_000;

/** The overview and index the agent's prompt carries: English overview, both titles per article. */
export const agentKnowledgeOf = (bundle: KbBundle): { overview: string; index: string } => {
  const czech = new Map(bundle.languages.cs.index.map((entry) => [entry.id, entry.title]));
  const index = bundle.languages.en.index
    .map((entry) => {
      const cs = czech.get(entry.id);
      return `- ${entry.id} (${entry.module}): ${entry.title}. ${entry.summary}${cs ? ` Czech title: ${cs}.` : ""}`;
    })
    .join("\n");
  return { overview: bundle.languages.en.overview, index };
};

/** Registered tools that no English article names in its `tools`. */
export const toolsWithoutArticle = (bundle: KbBundle, toolNames: readonly string[]): string[] => {
  const covered = new Set(bundle.languages.en.articles.flatMap((article) => article.tools));
  return toolNames.filter((name) => !covered.has(name));
};

const handOver = async (bundle: KbBundle) => {
  logger.info("knowledge_base.loaded", { version: bundle.version });
  // Imported here: the registry imports the docs tools, which import this module.
  const [{ TOOLS }, { updateAgentKnowledge }] = await Promise.all([
    import("../../tools/registry.js"),
    import("../assistant/agent/agentSync.js"),
  ]);
  const missing = toolsWithoutArticle(
    bundle,
    TOOLS.map((tool) => tool.name)
  );
  if (missing.length > 0) {
    logger.warn("knowledge_base.tool_without_article", { tools: missing });
    Sentry.captureMessage("A registered tool has no help article", {
      level: "warning",
      tags: { "knowledge_base.version": bundle.version },
      extra: { tools: missing },
    });
  }
  await updateAgentKnowledge(agentKnowledgeOf(bundle));
};

const createLoader = (): KnowledgeBaseLoader =>
  createKnowledgeBaseLoader({
    url: () => config.knowledgeBase.bundleUrl,
    refreshMs: config.knowledgeBase.refreshMs,
    retryMs: RETRY_MS,
    onBundle: handOver,
    onUnavailable: (error) => {
      logger.error("knowledge_base.unavailable", { error: errorName(error) });
      Sentry.captureMessage("The knowledge-base bundle has never loaded", {
        level: "error",
        extra: { error: errorName(error) },
      });
    },
    onStale: (error) => {
      logger.warn("knowledge_base.refresh_failed", { error: errorName(error) });
    },
  });

let loader = createLoader();

/** The process's knowledge base: the bundle at `KB_BUNDLE_URL`. */
export const knowledgeBase = (): KnowledgeBaseLoader => loader;

/** Tests: forget the loaded bundle, so the next use fetches `config.knowledgeBase.bundleUrl` again. */
export const resetKnowledgeBase = (): void => {
  loader = createLoader();
};

let timer: NodeJS.Timeout | undefined;

/**
 * Boot: load now, then revalidate on a timer so the agent's prompt follows the
 * bundle. Resolves after the first attempt, which hands a loaded bundle to the agent.
 */
export const startKnowledgeBase = (): Promise<void> => {
  timer ??= setInterval(() => void loader.refresh(), config.knowledgeBase.refreshMs);
  timer.unref();
  return loader.refresh();
};

export const stopKnowledgeBase = (): void => {
  clearInterval(timer);
  timer = undefined;
};

/** One language of the bundle, or `null` while no bundle was ever loaded. */
export const knowledgeBaseIn = async (language: KbLanguage) =>
  (await loader.get())?.languages[language] ?? null;

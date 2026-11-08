import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Sentry from "@sentry/node";
import { config } from "../../config.js";
import { currentAgentKnowledge } from "../../services/assistant/agent/agentSync.js";
import { knowledgeBase, resetKnowledgeBase } from "../../services/knowledgeBase/knowledgeBase.js";
import { kbSnapshot } from "../../tests/fixtures/kbSnapshot.js";
import { listenOnLoopback, type LoopbackServer } from "../../tests/loopbackServer.js";
import { findTool } from "../registry.js";
import { runTool } from "../runTool.js";
import type { ToolContext } from "../types.js";

const context: ToolContext = {
  auth: {
    sessionId: "s",
    userId: "u",
    userName: "Jana",
    userEmail: "jana@example.test",
    emailVerified: true,
    channel: "assistant",
  },
  organizationId: "org",
  access: "read",
  language: "cs",
};

const outbox: string[] = [];
const sent = async () => {
  await Sentry.flush(2000);
  return outbox.join("\n");
};

const serve = async (body: unknown): Promise<LoopbackServer> => {
  const server = await listenOnLoopback((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", ETag: '"t"' });
    res.end(JSON.stringify(body));
  });
  config.knowledgeBase.bundleUrl = `${server.url}/help/kb.json`;
  resetKnowledgeBase();
  return server;
};

describe("the docs tools", () => {
  const savedUrl = config.knowledgeBase.bundleUrl;
  let server: LoopbackServer | undefined;

  beforeAll(() => {
    Sentry.init({
      dsn: "https://public@sentry.invalid/1",
      defaultIntegrations: false,
      transport: () => ({
        send: (envelope) => {
          outbox.push(JSON.stringify(envelope));
          return Promise.resolve({});
        },
        flush: () => Promise.resolve(true),
      }),
    });
  });

  afterEach(async () => {
    outbox.length = 0;
    await server?.close();
    server = undefined;
    config.knowledgeBase.bundleUrl = savedUrl;
    resetKnowledgeBase();
  });

  afterAll(async () => {
    await Sentry.close();
  });

  it("refuse with an error and raise a Sentry event while no bundle was ever loaded", async () => {
    config.knowledgeBase.bundleUrl = "http://127.0.0.1:9/help/kb.json";
    resetKnowledgeBase();

    for (const [name, args] of [
      ["search_docs", { query: "půlden" }],
      ["read_doc", { id: "half-days-and-times" }],
    ] as const) {
      const run = await runTool(findTool(name)!, context, args);
      expect(run).toMatchObject({
        ok: false,
        outcome: "refused",
        error: {
          message: "Články nápovědy teď nejsou k dispozici. Zkuste to později.",
          context: { code: "KNOWLEDGE_BASE_UNAVAILABLE" },
        },
      });
    }
    expect(await sent()).toContain("The knowledge-base bundle has never loaded");
  });

  it("hand the overview and index to the agent and warn about a tool no article names", async () => {
    const bundle = kbSnapshot();
    bundle.languages.en.articles = bundle.languages.en.articles.map((article) => ({
      ...article,
      tools: article.tools.filter((tool) => tool !== "list_birthdays"),
    }));
    server = await serve(bundle);

    await knowledgeBase().refresh();

    const knowledge = currentAgentKnowledge();
    expect(knowledge?.overview).toBe(bundle.languages.en.overview);
    expect(knowledge?.index).toContain(
      "- half-days-and-times (leave): Book half a day or add times."
    );
    expect(knowledge?.index).toContain("Czech title: Půlden a časy.");
    const events = await sent();
    expect(events).toContain("A registered tool has no help article");
    expect(events).toContain("list_birthdays");
    expect(events).not.toContain("get_my_balances");
  });

  it("read one article as search_result blocks with its title and public URL", async () => {
    server = await serve(kbSnapshot());

    const run = await runTool(findTool("read_doc")!, context, { id: "half-days-and-times" });

    expect(run.ok).toBe(true);
    const blocks = (run as { result: unknown[] }).result as {
      type: string;
      source: string;
      title: string;
      citations: { enabled: boolean };
      content: { type: string; text: string }[];
    }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "search_result",
      source: "https://www.flexi-day.com/cs/help/half-days-and-times/",
      title: "Půlden a časy",
      citations: { enabled: true },
    });
    expect(blocks[0]!.content.length).toBeGreaterThan(1);
    expect(blocks[0]!.content.every((block) => block.type === "text")).toBe(true);
    expect(await sent()).toBe("");
  });

  it("refuse an article id that isn't in the bundle", async () => {
    server = await serve(kbSnapshot());

    const run = await runTool(
      findTool("read_doc")!,
      { ...context, language: "en" },
      { id: "no-such-article" }
    );

    expect(run).toMatchObject({
      ok: false,
      outcome: "refused",
      error: { message: "Help article not found", context: { code: "HELP_ARTICLE_NOT_FOUND" } },
    });
  });
});

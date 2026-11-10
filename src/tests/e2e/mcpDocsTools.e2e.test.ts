import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { config } from "../../config.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { db } from "../../db/db.js";
import { aiConnectionsLevel, organizations } from "../../db/schema/organization-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { appLanguage, userSettings } from "../../db/schema/user-settings-schema.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { addMember, makeGroup, makeUser } from "./helpers/reportFixtures.js";
import { createWebUser } from "./helpers/authHelper.js";
import { cleanupTestData } from "./helpers/testSetup.js";
import { connectAiApp, routePublicUrlTo } from "./helpers/aiConnectionGrant.js";
import { serveKnowledgeBase, withoutKnowledgeBase } from "./helpers/knowledgeBase.js";
import { kbSnapshot } from "../fixtures/kbSnapshot.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

const ON = { assistantEnabled: false, aiConnectionsEnabled: true, previewOrganizationIds: [] };
const ERAS = [
  { era: "2025 (initialize)", mode: "legacy" as const },
  { era: "2026-07-28 (server/discover)", mode: { pin: "2026-07-28" } },
];
const HALF_DAYS_CS = "https://www.flexi-day.com/cs/help/half-days-and-times/";

const bundle = kbSnapshot();

type SearchResult = {
  type: string;
  source: string;
  title: string;
  content: { type: string; text: string }[];
};

describe("/mcp docs tools and help resources", () => {
  let server: LoopbackServer;
  let restoreFetch: () => void;
  let stopKnowledgeBase: () => Promise<void>;
  let token: string;
  const savedSwitches = config.aiFeatures;

  beforeAll(async () => {
    config.aiFeatures = { ...ON };
    server = await listenOnLoopback(createServer());
    restoreFetch = routePublicUrlTo(server.url);
    stopKnowledgeBase = await serveKnowledgeBase();
    await cleanupTestData();

    const owner = await makeUser("Docs Owner");
    const groupId = await makeGroup("Docs Team", owner.id, { organizationOwnerId: owner.id });
    const [organization] = await db
      .update(organizations)
      .set({ name: "Docs", aiConnections: aiConnectionsLevel.Read })
      .where(eq(organizations.ownerUserId, owner.id))
      .returning({ id: organizations.id });
    const organizationId = organization!.id;
    await upsertSubscription(organizationId, {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });
    const jana = await createWebUser("Jana Docs");
    await addMember(groupId, jana.id);
    await syncEmployment(organizationId, owner.id);
    await syncEmployment(organizationId, jana.id);
    await db.insert(userSettings).values({ userId: jana.id, language: appLanguage.Czech });
    token = (await connectAiApp({ serverUrl: server.url, email: jana.email, organizationId }))
      .accessToken;
  });

  afterAll(async () => {
    config.aiFeatures = savedSwitches;
    restoreFetch();
    await stopKnowledgeBase();
    await server?.close();
    await cleanupTestData();
  });

  const connect = async (mode: (typeof ERAS)[number]["mode"]) => {
    const client = new Client({ name: "e2e", version: "1.0.0" }, { versionNegotiation: { mode } });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      })
    );
    return client;
  };

  const jsonOf = (result: { content?: unknown; isError?: unknown }) => {
    const [first] = result.content as { type: string; text: string }[];
    return JSON.parse(first!.text) as unknown;
  };

  describe.each(ERAS)("in the $era era", ({ mode }) => {
    it("finds an article by a Czech query with and without diacritics and reads it with its URL", async () => {
      const client = await connect(mode);
      try {
        const { tools } = await client.listTools();
        for (const name of ["search_docs", "read_doc"]) {
          const tool = tools.find((candidate) => candidate.name === name);
          expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
        }

        for (const query of ["Jak si vezmu půl dne volna?", "jak si vezmu pul dne volna"]) {
          const found = await client.callTool({ name: "search_docs", arguments: { query } });
          expect(found.isError).toBeFalsy();
          const { language, articles } = jsonOf(found) as {
            language: string;
            articles: { id: string; url: string }[];
          };
          expect(language).toBe("cs");
          expect(articles[0]).toMatchObject({ id: "half-days-and-times", url: HALF_DAYS_CS });
        }

        const read = await client.callTool({
          name: "read_doc",
          arguments: { id: "half-days-and-times" },
        });
        expect(read.isError).toBeFalsy();
        const [result] = jsonOf(read) as SearchResult[];
        expect(result).toMatchObject({
          type: "search_result",
          source: HALF_DAYS_CS,
          title: "Půlden a časy",
        });
        expect(result!.content.map((block) => block.text).join("\n")).toContain("## Půl dne");

        const english = await client.callTool({
          name: "read_doc",
          arguments: { id: "half-days-and-times", language: "en" },
        });
        expect((jsonOf(english) as SearchResult[])[0]!.source).toBe(
          "https://www.flexi-day.com/help/half-days-and-times/"
        );
      } finally {
        await client.close();
      }
    });

    it("carries the overview in the instructions and lists and reads the articles as resources", async () => {
      const client = await connect(mode);
      try {
        const instructions = client.getInstructions() ?? "";
        expect(instructions).toContain("search_docs");
        expect(instructions).toContain(bundle.languages.cs.overview);

        const { resources } = await client.listResources();
        expect(resources).toHaveLength(
          bundle.languages.en.articles.length + bundle.languages.cs.articles.length
        );
        expect(resources).toContainEqual(
          expect.objectContaining({
            uri: "flexi-day://help/cs/half-days-and-times",
            title: "Půlden a časy",
            mimeType: "text/markdown",
          })
        );

        const { contents } = await client.readResource({
          uri: "flexi-day://help/en/half-days-and-times",
        });
        expect(contents[0]).toMatchObject({
          uri: "flexi-day://help/en/half-days-and-times",
          mimeType: "text/markdown",
        });
        expect((contents[0] as { text: string }).text).toContain("# Book half a day or add times");

        await expect(
          client.readResource({ uri: "flexi-day://help/en/no-such-article" })
        ).rejects.toThrow();
      } finally {
        await client.close();
      }
    });
  });

  it("answers an error from both tools while no bundle has ever loaded", async () => {
    const restore = withoutKnowledgeBase();
    const client = await connect("legacy");
    try {
      expect(client.getInstructions()).not.toContain(bundle.languages.cs.overview);
      for (const [name, args] of [
        ["search_docs", { query: "půlden" }],
        ["read_doc", { id: "half-days-and-times" }],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBe(true);
        expect(jsonOf(result)).toEqual({
          error: {
            message: "Články nápovědy teď nejsou k dispozici. Zkuste to později.",
            context: { code: "KNOWLEDGE_BASE_UNAVAILABLE" },
          },
        });
      }
    } finally {
      await client.close();
      restore();
    }
  });
});

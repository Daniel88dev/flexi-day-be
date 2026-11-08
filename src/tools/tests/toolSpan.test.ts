import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as Sentry from "@sentry/node";
import { z } from "zod";
import { runTool } from "../runTool.js";
import { defineTool, type ToolContext } from "../types.js";
import AppError from "../../utils/appError.js";

const ARGUMENT = "argument-marker-4f1c";
const RESULT = "result-marker-9b2e";

const echo = defineTool({
  name: "echo_marker",
  description: "Test tool.",
  input: z.object({ query: z.string() }),
  annotations: { readOnlyHint: true },
  kind: "read",
  userText: ["text"],
  handler: (_ctx, input) => {
    if (input.query.startsWith("refuse")) {
      return Promise.reject(new AppError({ code: 403, message: `Refused ${RESULT}` }));
    }
    return Promise.resolve({ text: `${RESULT} for ${input.query}` });
  },
});

const contextFor = (channel: "mcp" | "assistant"): ToolContext => ({
  auth: {
    sessionId: "s",
    userId: "u",
    userName: "Jana",
    userEmail: "jana@example.test",
    emailVerified: true,
    channel,
  },
  organizationId: "org",
  access: "read",
  language: "en",
});

/** Everything the SDK would send, as it would leave the process. */
const outbox: string[] = [];

describe("the gen_ai.execute_tool span", () => {
  beforeAll(() => {
    Sentry.init({
      dsn: "https://public@sentry.invalid/1",
      tracesSampleRate: 1,
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

  afterAll(async () => {
    await Sentry.close();
  });

  it.each([
    { channel: "mcp" as const, query: "ok", outcome: "ok" },
    { channel: "assistant" as const, query: "refuse", outcome: "refused" },
  ])(
    "names the tool, channel and outcome ($channel, $outcome) and carries neither argument nor result",
    async ({ channel, query, outcome }) => {
      outbox.length = 0;
      const run = await runTool(echo, contextFor(channel), { query: `${query} ${ARGUMENT}` });
      await Sentry.flush(2000);

      expect(JSON.stringify(run)).toContain(RESULT);
      const sent = outbox.join("\n");
      expect(sent).toContain("gen_ai.execute_tool");
      expect(sent).toContain("echo_marker");
      expect(sent).toContain(`"flexiday.channel"`);
      expect(sent).toContain(`"${channel}"`);
      expect(sent).toContain(`"${outcome}"`);
      expect(sent).not.toContain(ARGUMENT);
      expect(sent).not.toContain(RESULT);
    }
  );
});

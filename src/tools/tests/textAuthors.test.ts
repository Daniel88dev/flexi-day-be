import { describe, it, expect } from "vitest";
import { z } from "zod";
import { runTool } from "../runTool.js";
import { authorsOf, withTextAuthors } from "../textAuthors.js";
import { defineTool, type ToolContext } from "../types.js";

type Entry = { personId: string; personName: string; note: string | null };

const notes = defineTool({
  name: "list_notes",
  description: "Test tool.",
  input: z.object({}),
  annotations: { readOnlyHint: true },
  kind: "read",
  userText: ["entries[].note"],
  handler: () => {
    const entries: Entry[] = [
      { personId: "u-eva", personName: "Eva", note: "Back on Monday" },
      { personId: "u-eva", personName: "Eva", note: "Dentist" },
      { personId: "u-jan", personName: "Jan", note: null },
      { personId: "u-ola", personName: "Ola", note: "  " },
      { personId: "u-max", personName: "Max", note: "Moving house" },
    ];
    return Promise.resolve(
      withTextAuthors(
        { entries },
        authorsOf(
          entries,
          (entry) => [entry.note],
          (entry) => ({ userId: entry.personId, name: entry.personName })
        )
      )
    );
  },
});

const ctx: ToolContext = {
  auth: {
    sessionId: "s",
    userId: "u-jana",
    userName: "Jana",
    userEmail: "jana@example.test",
    emailVerified: true,
    channel: "assistant",
  },
  organizationId: "org",
  access: "read",
  language: "en",
};

describe("who wrote the free text a tool returns", () => {
  it("names each author of a non-blank text once, and keeps them out of the result", async () => {
    const run = await runTool(notes, ctx, {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.authors).toEqual([
      { userId: "u-eva", name: "Eva" },
      { userId: "u-max", name: "Max" },
    ]);
    expect(Object.keys(run.result as object)).toEqual(["entries"]);
  });

  it("names nobody for a tool that declares no authors", async () => {
    const plain = defineTool({
      name: "plain",
      description: "Test tool.",
      input: z.object({}),
      annotations: { readOnlyHint: true },
      kind: "read",
      userText: [],
      handler: () => Promise.resolve({ value: 1 }),
    });
    const run = await runTool(plain, ctx, {});
    expect(run.ok && run.authors).toEqual([]);
  });
});

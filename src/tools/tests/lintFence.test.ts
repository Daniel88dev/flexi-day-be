import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";

const lintAsToolLayer = async (code: string) => {
  const eslint = new ESLint({
    cwd: process.cwd(),
    ruleFilter: ({ ruleId }) => ruleId === "no-restricted-imports",
  });
  // An existing file of the layer, so the type-aware parser finds it in the project.
  const [result] = await eslint.lintText(code, { filePath: "src/tools/registry.ts" });
  return result!.messages.map((message) => message.ruleId);
};

describe("the lint fence on the tool layer", () => {
  it.each([
    ['import { db } from "../db/db.js";'],
    ['import { vacation } from "../../db/schema/vacation-schema.js";'],
    ['import { eq } from "drizzle-orm";'],
    ['import { Pool } from "pg";'],
  ])(
    "fails on a database import: %s",
    async (line) => {
      expect(await lintAsToolLayer(`${line}\nexport const x = 1;\n`)).toEqual([
        "no-restricted-imports",
      ]);
    },
    60_000
  );

  it("lets the layer import a service", async () => {
    expect(
      await lintAsToolLayer(
        'import { getMyBalances } from "../services/userYearQuotas/balanceReads.js";\nexport const x = getMyBalances;\n'
      )
    ).toEqual([]);
  }, 60_000);
});

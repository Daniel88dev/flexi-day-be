import { describe, expect, it } from "vitest";
import { composedAtImport, runSelect, runTransaction } from "./queriesTheDatabaseFixture.js";

// Guards the guard: if a drizzle upgrade moves the builder protocol, queries still fail
// but stop naming a module, which nothing else would notice. Repair this, don't delete it.
describe("the unit test database guard", () => {
  const fixture = /src\/tests\/queriesTheDatabaseFixture\.ts/;

  it("names the module that executed a query", async () => {
    await expect(runSelect()).rejects.toThrow(fixture);
  });

  it("names the module that opened a transaction", async () => {
    await expect(runTransaction()).rejects.toThrow(fixture);
  });

  it("says how to mock the module it named", async () => {
    await expect(runSelect()).rejects.toThrow(/vi\.mock\("<relative path>\/db\/db\.js"/);
  });

  it("lets a module compose SQL at import time without executing it", () => {
    expect(composedAtImport).toBeDefined();
  });
});

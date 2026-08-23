import { describe, it, expect } from "vitest";
import { createLocalAccountIssuer, createOAuthAccountIssuer } from "better-auth/db";
import { socialProviders } from "better-auth/social-providers";
import { readFileSync } from "node:fs";

/**
 * The 0001 backfill hard-codes issuer strings, because SQL cannot call
 * better-auth. These assertions are what keeps the literals honest: if an
 * upgrade changes how better-auth derives an issuer, the rows written by the
 * migration stop matching the rows better-auth looks up, and every affected
 * user silently loses social sign-in. That failure is invisible in every other
 * test, so it is pinned here instead.
 */
const migration = readFileSync(
  new URL("../../db/schema/out/0001_account_issuer.sql", import.meta.url),
  "utf8"
);

const credentials = { clientId: "test-client", clientSecret: "test-secret" };

describe("account.issuer backfill", () => {
  it("writes the credential issuer better-auth resolves", () => {
    expect(createLocalAccountIssuer("credential")).toBe("local:credential");
    expect(migration).toContain("SET \"issuer\" = 'local:credential'");
  });

  it("writes Google's own OIDC issuer, not the synthetic one", () => {
    const google = socialProviders.google(credentials);
    expect(google.accountIssuer).toBe("https://accounts.google.com");
    expect(migration).toContain(`SET "issuer" = '${google.accountIssuer}'`);
    // The synthetic form is what a provider without an issuer would get, and
    // is exactly the value this migration must NOT write for Google.
    expect(createOAuthAccountIssuer("google")).toBe("local:oauth:google");
    expect(migration).not.toContain("local:oauth:google");
  });

  it("leaves Google's account_id alone, because its subject is still `sub`", () => {
    // The other half of the key. If a later better-auth hashes or re-pairs the
    // subject, the backfill would write a correct issuer against a stale
    // account_id and every Google user would fail to sign in — with the issuer
    // assertion above still passing. That is the failure this pins down.
    const google = socialProviders.google(credentials);
    expect(google.accountSubject({ profile: { sub: "subject-123" } })).toBe("subject-123");
  });

  it("re-keys Microsoft from the stored id_token rather than dropping the link", () => {
    const microsoft = socialProviders.microsoft(credentials);
    // Both halves of Microsoft's key move in 1.7: the issuer is resolved from
    // the token's own `iss` rather than being a constant, and the subject is
    // the directory `oid` in place of the pairwise `sub`.
    const iss = "https://login.microsoftonline.com/tenant-guid/v2.0";
    expect(typeof microsoft.accountIssuer).toBe("function");
    expect(microsoft.accountIssuer({ profile: { iss } })).toBe(iss);
    expect(microsoft.accountSubject({ profile: { oid: "dir-oid-1", sub: "pairwise-1" } })).toBe(
      "dir-oid-1"
    );
    // Matched as one statement, not two loose substrings: asserting the claims
    // appear somewhere would still pass with the two of them swapped, which is
    // the mapping error that would strand every Microsoft user.
    expect(migration).toContain(
      `UPDATE "account" SET "issuer" = claim_iss, "account_id" = claim_oid`
    );
    expect(migration).toContain("claim_iss := payload ->> 'iss'");
    expect(migration).toContain("claim_oid := payload ->> 'oid'");
    // A blanket delete would throw away links that the id_token can rebuild.
    expect(migration).not.toContain(`DELETE FROM "account" WHERE "provider_id" = 'microsoft'`);
  });

  it("records every dropped link, because a notice from drizzle-kit goes nowhere", () => {
    // `drizzle-kit migrate` installs no `notice` listener on the pg client, so
    // the only durable record of who must be emailed is a table.
    expect(migration).toContain(`INSERT INTO "account_issuer_migration_dropped"`);
    const recorded = migration.indexOf(`INSERT INTO "account_issuer_migration_dropped"`);
    const deleted = migration.indexOf(`DELETE FROM "account" WHERE "id" = r."id"`);
    expect(recorded).toBeGreaterThan(-1);
    expect(deleted).toBeGreaterThan(recorded);
  });

  it("adds issuer nullable, backfills, then constrains — never NOT NULL up front", () => {
    const addColumn = migration.indexOf('ADD COLUMN "issuer" text');
    const setNotNull = migration.indexOf('ALTER COLUMN "issuer" SET NOT NULL');
    expect(addColumn).toBeGreaterThan(-1);
    expect(setNotNull).toBeGreaterThan(addColumn);
    expect(migration).not.toContain('ADD COLUMN "issuer" text NOT NULL');
  });

  it("refuses to constrain the column while any provider is unmapped", () => {
    const guard = migration.indexOf("has no mapping for provider_id");
    expect(guard).toBeGreaterThan(-1);
    expect(migration.indexOf('ALTER COLUMN "issuer" SET NOT NULL')).toBeGreaterThan(guard);
  });
});

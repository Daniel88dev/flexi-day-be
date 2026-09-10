import { describe, it, expect } from "vitest";
import { socialProviders } from "better-auth/social-providers";
import { readFileSync } from "node:fs";

/**
 * better-auth 1.7.3 reverted the account key to `(providerId, accountId)`, but
 * it did not revert the other half of what 0001 wrote: Microsoft accounts are
 * still keyed by the directory `oid` rather than the pairwise `sub`. That half
 * is now load-bearing on its own. If a later release moves the subject claim
 * back, the rows 0001 rewrote stop matching the rows better-auth looks up and
 * every Microsoft user silently loses social sign-in. Nothing else would catch
 * it, so it is pinned here.
 */
const migration = readFileSync(
  new URL("../../db/schema/out/0001_account_issuer.sql", import.meta.url),
  "utf8"
);

const credentials = { clientId: "test-client", clientSecret: "test-secret" };

describe("account key survives the issuer revert", () => {
  it("resolves Microsoft's subject from the directory oid", () => {
    const microsoft = socialProviders.microsoft(credentials);
    expect(microsoft.accountSubject({ profile: { oid: "dir-oid-1", sub: "pairwise-1" } })).toBe(
      "dir-oid-1"
    );
    expect(migration).toContain("claim_oid := payload ->> 'oid'");
    // Matched as one statement, not two loose substrings: asserting the claims
    // appear somewhere would still pass with the two of them swapped, which is
    // the mapping error that would strand every Microsoft user.
    expect(migration).toContain(
      `UPDATE "account" SET "issuer" = claim_iss, "account_id" = claim_oid`
    );
    // A blanket delete would have thrown away links the id_token can rebuild.
    expect(migration).not.toContain(`DELETE FROM "account" WHERE "provider_id" = 'microsoft'`);
  });

  it("leaves Google's subject as sub", () => {
    const google = socialProviders.google(credentials);
    expect(google.accountSubject({ profile: { sub: "subject-123" } })).toBe("subject-123");
  });
});

import { describe, expect, it } from "vitest";
import { auth } from "../../utils/auth.js";

type Matcher = (context: { path: string }) => boolean;

function twoFactorMatcher(): Matcher {
  const plugin = auth.options.plugins.find((candidate) => candidate.id === "two-factor");
  const hook = plugin?.hooks?.after?.[0];
  if (!hook) throw new Error("the two-factor plugin has no after hook");
  return hook.matcher as Matcher;
}

describe("the two-factor challenge", () => {
  it.each(["/sign-in/email", "/sign-in/username", "/sign-in/phone-number"])(
    "runs on %s",
    (path) => {
      expect(twoFactorMatcher()({ path })).toBe(true);
    }
  );

  it.each(["/sign-in/social", "/callback/:id", "/callback/apple"])(
    "does not run on social sign-in at %s",
    (path) => {
      // Social sign-in relies on the provider's own second factor. If the
      // plugin starts matching these paths, every social user with two-factor
      // on meets our code challenge, which is a product decision to take on
      // purpose rather than through an upgrade.
      expect(twoFactorMatcher()({ path })).toBe(false);
    }
  );

  it("has exactly one after hook, the one checked above", () => {
    const plugin = auth.options.plugins.find((candidate) => candidate.id === "two-factor");
    expect(plugin?.hooks?.after).toHaveLength(1);
  });
});

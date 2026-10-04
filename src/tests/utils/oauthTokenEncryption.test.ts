import { describe, expect, it } from "vitest";
import { auth } from "../../utils/auth.js";
import { decryptStoredOAuthToken, encryptOAuthToken } from "../../utils/oauthTokens.js";

describe("stored OAuth tokens", () => {
  it("are encrypted at rest", () => {
    expect(auth.options.account?.encryptOAuthTokens).toBe(true);
  });

  it("round-trip through better-auth's own helpers", async () => {
    const stored = await encryptOAuthToken("r.apple-refresh-token");

    expect(stored).not.toBe("r.apple-refresh-token");
    expect(await decryptStoredOAuthToken(stored)).toBe("r.apple-refresh-token");
  });

  // Rows written before encryption went on hold plaintext, and nothing migrates
  // them. better-auth's likely-encrypted guard is what keeps them readable.
  it.each([
    ["a Google refresh token", "1//09abcDEFghiJKLmnoPQRstuVWXyz-0123456789_abcdefghijklmnop"],
    ["a Microsoft refresh token", "M.C512_BAY.0.U.-CsdKqv9!ZwXn*Vb3eRk8pLmQ$"],
    ["an Apple refresh token", "r1a2b3c4d5e6f7.0.nrrsx.Q8mWkzL0b9pTq-uv3HfR1A"],
  ])("still read %s stored in plaintext", async (_label, legacy) => {
    expect(await decryptStoredOAuthToken(legacy)).toBe(legacy);
  });
});

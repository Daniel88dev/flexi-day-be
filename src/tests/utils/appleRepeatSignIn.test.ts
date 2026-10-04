import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { decryptOAuthToken, setTokenUtil } from "better-auth/oauth2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAccountLinking } from "../../utils/socialProviders.js";
import { appleCredentials, socialProvidersFrom } from "../appleFixtures.js";
import { newSigningKey, signIdToken, stubKeySet } from "../idTokenFixtures.js";

const SUBJECT = "001234.abcdef0123456789.1234";

afterEach(() => {
  vi.unstubAllGlobals();
});

// The Apple authorization route is the only writer of a phone link's refresh
// token. A later phone sign-in posts an id token and nothing else, so if
// better-auth started writing absent tokens as null, deletion would have
// nothing left to revoke.
describe("a repeat Apple sign-in on the phone", () => {
  it("keeps the refresh token the authorization route stored", async () => {
    const key = await newSigningKey("apple-key-1");
    stubKeySet("https://appleid.apple.com/auth/keys", [key.jwk]);

    const now = new Date();
    const tables: Record<string, Record<string, unknown>[]> = {
      user: [
        {
          id: "user-1",
          name: "Ada",
          email: "ada@example.com",
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
      account: [],
      session: [],
      verification: [],
    };
    const socialProviders = socialProvidersFrom(appleCredentials());
    const instance = betterAuth({
      secret: "a-test-secret-that-is-long-enough-for-better-auth",
      baseURL: "http://localhost:8080",
      database: memoryAdapter(tables),
      socialProviders,
      account: { encryptOAuthTokens: true, accountLinking: buildAccountLinking(socialProviders) },
    });
    const context = await instance.$context;
    const storedRefresh = await setTokenUtil("apple-refresh-token", context);
    tables.account?.push({
      id: "account-1",
      userId: "user-1",
      providerId: "apple",
      accountId: SUBJECT,
      refreshToken: storedRefresh,
      accessToken: await setTokenUtil("apple-access-token", context),
      idToken: "earlier-id-token",
      createdAt: now,
      updatedAt: now,
    });

    const token = await signIdToken(key, {
      iss: "https://appleid.apple.com",
      aud: "com.flexiday.app",
      sub: SUBJECT,
      email: "ada@example.com",
    });
    await instance.api.signInSocial({ body: { provider: "apple", idToken: { token } } });

    const [row] = tables.account ?? [];
    expect(row?.idToken).toBe(token);
    expect(row?.refreshToken).toBe(storedRefresh);
    expect(await decryptOAuthToken(String(row?.refreshToken), context)).toBe("apple-refresh-token");
    expect(await decryptOAuthToken(String(row?.accessToken), context)).toBe("apple-access-token");
  });
});

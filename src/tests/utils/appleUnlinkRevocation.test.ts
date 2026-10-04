import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { setTokenUtil } from "better-auth/oauth2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../middleware/logger.js";
import { appleUnlinkRevocation } from "../../utils/appleUnlinkRevocation.js";
import { auth } from "../../utils/auth.js";
import { appleClientFrom, buildAccountLinking } from "../../utils/socialProviders.js";
import {
  appleCredentials,
  decodeJwtPart,
  socialProvidersFrom,
  storedIdToken,
  stubAppleRevoke,
} from "../appleFixtures.js";

let apple: ReturnType<typeof stubAppleRevoke>;

/**
 * A better-auth instance with the plugin as `auth.ts` registers it, a signed-in
 * password user, and an Apple and a Google link on that user.
 */
async function signedInWithLinks() {
  const credentials = appleCredentials();
  const socialProviders = socialProvidersFrom(credentials);
  const tables: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
  };
  const instance = betterAuth({
    secret: "a-test-secret-that-is-long-enough-for-better-auth",
    baseURL: "http://localhost:8080",
    database: memoryAdapter(tables),
    emailAndPassword: { enabled: true },
    socialProviders,
    account: { encryptOAuthTokens: true, accountLinking: buildAccountLinking(socialProviders) },
    plugins: [appleUnlinkRevocation(appleClientFrom(credentials))],
  });

  const { headers, response } = await instance.api.signUpEmail({
    body: { email: "ada@example.com", password: "a long enough password", name: "Ada" },
    returnHeaders: true,
  });
  const cookie = (headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const userId = response.user.id;

  const context = await instance.$context;
  const now = new Date();
  tables.account?.push(
    {
      id: "account-apple",
      userId,
      providerId: "apple",
      accountId: "001234.abcdef0123456789.1234",
      refreshToken: await setTokenUtil("apple-refresh-token", context),
      idToken: storedIdToken({ aud: "com.flexiday.app", sub: "001234.abcdef0123456789.1234" }),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "account-google",
      userId,
      providerId: "google",
      accountId: "google-subject",
      refreshToken: await setTokenUtil("google-refresh-token", context),
      createdAt: now,
      updatedAt: now,
    }
  );

  const unlink = (accountId: string) =>
    instance.api.unlinkAccount({ headers: new Headers({ cookie }), body: { accountId } });

  return { tables, unlink, userId };
}

beforeEach(() => {
  apple = stubAppleRevoke();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("unlinking an account", () => {
  it("revokes an Apple link at Apple, as the client its token was issued to", async () => {
    const { tables, unlink } = await signedInWithLinks();

    expect(await unlink("account-apple")).toEqual({ status: true });

    const forms = apple.revokeForms();
    expect(forms).toHaveLength(1);
    expect(forms[0]?.get("token")).toBe("apple-refresh-token");
    expect(forms[0]?.get("token_type_hint")).toBe("refresh_token");
    expect(forms[0]?.get("client_id")).toBe("com.flexiday.app");
    expect(decodeJwtPart(forms[0]?.get("client_secret") ?? undefined, 1)).toMatchObject({
      sub: "com.flexiday.app",
    });
    expect(tables.account?.map((row) => row.id)).not.toContain("account-apple");
  });

  it("does not call Apple for a Google link", async () => {
    const { tables, unlink } = await signedInWithLinks();

    expect(await unlink("account-google")).toEqual({ status: true });

    expect(apple.revokeForms()).toHaveLength(0);
    expect(tables.account?.map((row) => row.id)).not.toContain("account-google");
  });

  it("still reports the unlink when Apple refuses the revoke", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => logger);
    apple.answerWith(() =>
      Promise.resolve(Response.json({ error: "invalid_client" }, { status: 400 }))
    );
    const { tables, unlink, userId } = await signedInWithLinks();

    expect(await unlink("account-apple")).toEqual({ status: true });

    expect(apple.revokeForms()).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledWith(
      "apple.revoke.rejected",
      expect.objectContaining({ userId, linkId: "account-apple" })
    );
    expect(tables.account?.map((row) => row.id)).not.toContain("account-apple");
  });

  it("revokes nothing when the unlink itself is refused", async () => {
    const { tables, unlink } = await signedInWithLinks();
    // better-auth refuses to unlink the last way into an account.
    tables.account = tables.account?.filter((row) => row.id === "account-apple");

    await expect(unlink("account-apple")).rejects.toThrow();

    expect(apple.revokeForms()).toHaveLength(0);
    expect(tables.account?.map((row) => row.id)).toEqual(["account-apple"]);
  });

  it("revokes nothing for an account row the caller does not hold", async () => {
    const { unlink } = await signedInWithLinks();

    await expect(unlink("account-of-someone-else")).rejects.toThrow();

    expect(apple.revokeForms()).toHaveLength(0);
  });

  it("is registered on the app's auth instance", () => {
    expect(auth.options.plugins.map((plugin) => plugin.id)).toContain("apple-unlink-revocation");
  });
});

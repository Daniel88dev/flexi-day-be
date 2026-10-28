import { describe, it, expect } from "vitest";
import { betterAuth, type AuthContext, type BetterAuthOptions } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { decryptOAuthToken, setTokenUtil } from "better-auth/oauth2";
import { twoFactor } from "better-auth/plugins";
import { base32 } from "@better-auth/utils/base32";

const OLD = "old-secret-Vq7Rz2mWb9XfT4nLp8VdC3sHy6JgA1eE5uKo";
const NEW = "new-secret-Kx3Jm9VqT2mWb8YfR5nLp1DcZ7sHg4AeQ0Wi";
const PASSWORD = "a long enough password";

type SecretOptions = Pick<BetterAuthOptions, "secret" | "secrets">;

/** What the app ran with before versioning. */
const unversioned: SecretOptions = { secret: OLD };
/** What `config.ts` builds from a lone `BETTER_AUTH_SECRET`, or `BETTER_AUTH_SECRETS=1:<old>`. */
const adopted: SecretOptions = { secrets: [{ version: 1, value: OLD }], secret: OLD };
/** One Terraform rotation later: `BETTER_AUTH_SECRETS=2:<new>,1:<old>`. */
const rotated: SecretOptions = {
  secrets: [
    { version: 2, value: NEW },
    { version: 1, value: OLD },
  ],
  secret: OLD,
};

const instance = (tables: Record<string, Record<string, unknown>[]>, secrets: SecretOptions) =>
  betterAuth({
    ...secrets,
    baseURL: "http://localhost:8080",
    database: memoryAdapter(tables),
    emailAndPassword: { enabled: true },
    account: { encryptOAuthTokens: true },
    plugins: [twoFactor({ issuer: "Flexi Day" })],
  });

type Instance = ReturnType<typeof instance>;

const cookieHeader = (headers: Headers) =>
  new Headers({
    cookie: headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  });

const totpCode = async (auth: Instance, totpURI: string) => {
  const encoded = new URL(totpURI).searchParams.get("secret") ?? "";
  const raw = new TextDecoder().decode(base32.decode(encoded));
  return (await auth.api.generateTOTP({ body: { secret: raw } })).code;
};

/** Signs up and turns on two-factor, so the TOTP secret and backup codes are encrypted under `secrets`. */
const enrolUnder = async (secrets: SecretOptions) => {
  const tables: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    twoFactor: [],
  };
  const auth = instance(tables, secrets);
  const email = "ada@example.com";
  const { headers } = await auth.api.signUpEmail({
    body: { email, password: PASSWORD, name: "Ada" },
    returnHeaders: true,
  });
  const session = cookieHeader(headers);
  const enrolment = await auth.api.enableTwoFactor({
    body: { password: PASSWORD },
    headers: session,
  });
  if (enrolment.method !== "totp") throw new Error("expected a TOTP enrolment");
  const { totpURI, backupCodes } = enrolment;
  await auth.api.verifyTOTP({
    body: { code: await totpCode(auth, totpURI) },
    headers: session,
  });
  return { tables, email, totpURI, backupCodes };
};

const challenge = async (auth: Instance, email: string) => {
  const { headers, response } = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  expect(response).toMatchObject({ twoFactorRedirect: true });
  return cookieHeader(headers);
};

const context = async (auth: Instance) => (await auth.$context) as unknown as AuthContext;

describe.each([
  ["before versioning", unversioned, /^[0-9a-f]+$/],
  ["under version 1", adopted, /^\$ba\$1\$/],
])("data written %s still decrypts after a rotation", (_, writtenUnder, shape) => {
  it("stored the secret in the shape that version writes", async () => {
    const { tables } = await enrolUnder(writtenUnder);

    expect(tables.twoFactor?.[0]?.secret).toMatch(shape);
    expect(tables.twoFactor?.[0]?.backupCodes).toMatch(shape);
  });

  it("accepts a TOTP code", async () => {
    const { tables, email, totpURI } = await enrolUnder(writtenUnder);
    const after = instance(tables, rotated);

    const res = await after.api.verifyTOTP({
      body: { code: await totpCode(after, totpURI) },
      headers: await challenge(after, email),
    });

    expect(res.token).toEqual(expect.any(String));
  });

  it("accepts a backup code", async () => {
    const { tables, email, backupCodes } = await enrolUnder(writtenUnder);
    const after = instance(tables, rotated);

    const res = await after.api.verifyBackupCode({
      body: { code: backupCodes[0] ?? "" },
      headers: await challenge(after, email),
    });

    expect(res.token).toEqual(expect.any(String));
  });

  it("reads a calendar token back", async () => {
    // `encryptOAuthToken` and `decryptStoredOAuthToken` are these two calls on the app's context.
    const tables = { user: [], session: [], account: [], verification: [], twoFactor: [] };
    const stored = await setTokenUtil(
      "refresh-token",
      await context(instance(tables, writtenUnder))
    );

    expect(stored).toMatch(shape);
    expect(await decryptOAuthToken(stored!, await context(instance(tables, rotated)))).toBe(
      "refresh-token"
    );
  });
});

it("writes new ciphertext under the newest version", async () => {
  const { tables } = await enrolUnder(rotated);

  expect(tables.twoFactor?.[0]?.secret).toMatch(/^\$ba\$2\$/);
});

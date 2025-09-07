/**
 * Tests for src/tests/auth.test.ts (module exporting configured `auth`)
 * Framework: Jest (TypeScript). If the repo uses Vitest, replace jest.* with vi.* equivalents.
 *
 * We validate:
 * - betterAuth called exactly once with expected top-level keys
 * - drizzleAdapter called with db and provider 'pg'
 * - email/password + verification handlers call tempEmailSend with correct payloads
 * - rateLimit settings (enabled, window, max)
 * - plugins are invoked (haveIBeenPwned, openAPI) and passed into config
 */

type AnyFn = (...args: any[]) => any;

const mockTempEmailSend = jest.fn();

const drizzleAdapterMock = jest.fn(() => ({ __adapter: "drizzle" }));
const betterAuthCallArgs: any[] = [];
const betterAuthReturn = { __auth: true };

const haveIBeenPwnedSpy = jest.fn(() => ({ name: "haveIBeenPwned" }));
const openAPISpy = jest.fn(() => ({ name: "openAPI" }));

// Mock modules before importing the module under test
jest.mock("better-auth", () => {
  const mock: AnyFn = (config: any) => {
    betterAuthCallArgs.push(config);
    return betterAuthReturn;
  };
  return { betterAuth: mock };
});

jest.mock("better-auth/adapters/drizzle", () => {
  return { drizzleAdapter: drizzleAdapterMock };
});

// Mock db module referenced by the file under test
jest.mock("../db/db.js", () => {
  return { db: { __db: "pg-drizzle" } };
});

// Mock temp email sender
jest.mock("../tests/tempEmail.js", () => {
  return { tempEmailSend: mockTempEmailSend };
});

// Mock plugins module so we can assert invocation
jest.mock("better-auth/plugins", () => {
  return {
    haveIBeenPwned: haveIBeenPwnedSpy,
    openAPI: openAPISpy,
  };
});

describe("auth configuration module (src/tests/auth.test.ts)", () => {
  beforeEach(() => {
    mockTempEmailSend.mockClear();
    drizzleAdapterMock.mockClear();
    haveIBeenPwnedSpy.mockClear();
    openAPISpy.mockClear();
    betterAuthCallArgs.length = 0;
  });

  async function importModule() {
    // Import dynamically after mocks are set up
    return await import("../auth.test.ts");
  }

  test("invokes betterAuth exactly once with expected configuration shape", async () => {
    const mod = await importModule();
    expect(mod).toBeTruthy();
    expect(betterAuthCallArgs.length).toBe(1);

    const cfg = betterAuthCallArgs[0];
    expect(cfg).toBeTruthy();

    // Top-level keys
    expect(Object.keys(cfg)).toEqual(
      expect.arrayContaining([
        "database",
        "emailAndPassword",
        "emailVerification",
        "rateLimit",
        "plugins",
      ])
    );
  });

  test("uses drizzle adapter with pg provider and provided db", async () => {
    await importModule();

    // drizzleAdapter should have been called with (db, { provider: "pg" })
    expect(drizzleAdapterMock).toHaveBeenCalledTimes(1);
    const [dbArg, optionsArg] = drizzleAdapterMock.mock.calls[0];
    expect(dbArg).toEqual({ __db: "pg-drizzle" });
    expect(optionsArg).toEqual({ provider: "pg" });
  });

  test("plugins haveIBeenPwned and openAPI are invoked and included", async () => {
    await importModule();

    expect(haveIBeenPwnedSpy).toHaveBeenCalledTimes(1);
    expect(openAPISpy).toHaveBeenCalledTimes(1);

    const cfg = betterAuthCallArgs[0];
    expect(Array.isArray(cfg.plugins)).toBe(true);
    // Expect our plugin markers present
    expect(cfg.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "haveIBeenPwned" }),
        expect.objectContaining({ name: "openAPI" }),
      ])
    );
  });

  test("rateLimit is enabled with correct window and max", async () => {
    await importModule();

    const cfg = betterAuthCallArgs[0];
    expect(cfg.rateLimit).toEqual({ enabled: true, window: 10, max: 5 });
  });

  test("emailAndPassword is enabled and requires email verification", async () => {
    await importModule();

    const cfg = betterAuthCallArgs[0];
    expect(cfg.emailAndPassword).toMatchObject({
      enabled: true,
      requireEmailVerification: true,
    });
    expect(typeof cfg.emailAndPassword.sendResetPassword).toBe("function");
  });

  test("emailVerification settings and sendVerificationEmail handler", async () => {
    await importModule();

    const cfg = betterAuthCallArgs[0];
    expect(cfg.emailVerification).toMatchObject({
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
    });
    expect(typeof cfg.emailVerification.sendVerificationEmail).toBe("function");
  });

  test("sendResetPassword calls tempEmailSend with expected content", async () => {
    await importModule();

    const cfg = betterAuthCallArgs[0];
    const handler: AnyFn = cfg.emailAndPassword.sendResetPassword;
    const fake = {
      user: { email: "alice@example.com" },
      url: "https://app.example.com/reset?token=abc",
      token: "abc",
    };
    await handler({ user: fake.user, url: fake.url, token: fake.token }, {} as any);

    expect(mockTempEmailSend).toHaveBeenCalledTimes(1);
    const payload = mockTempEmailSend.mock.calls[0][0];
    expect(payload).toMatchObject({
      to: "alice@example.com",
      subject: "Reset your password",
    });
    // Ensure token and URL are embedded in text
    expect(payload.text).toContain(fake.url);
    expect(payload.text).toContain(fake.token);
  });

  test("sendVerificationEmail calls tempEmailSend with expected content", async () => {
    await importModule();

    const cfg = betterAuthCallArgs[0];
    const handler: AnyFn = cfg.emailVerification.sendVerificationEmail;
    const fake = {
      user: { email: "bob@example.com" },
      url: "https://app.example.com/verify?token=xyz",
      token: "xyz",
    };
    await handler({ user: fake.user, url: fake.url, token: fake.token }, {} as any);

    expect(mockTempEmailSend).toHaveBeenCalledTimes(1);
    const payload = mockTempEmailSend.mock.calls[0][0];
    expect(payload).toMatchObject({
      to: "bob@example.com",
      subject: "Verify your email address",
    });
    expect(payload.text).toContain(fake.url);
    expect(payload.text).toContain(fake.token);
  });

  test("exported auth value is the return of betterAuth", async () => {
    const mod = await importModule();
    expect(mod.auth).toBe(betterAuthReturn);
  });

  describe("defensive: unexpected inputs to handlers", () => {
    test("sendResetPassword does not throw on minimally shaped input", async () => {
      await importModule();
      const cfg = betterAuthCallArgs[0];
      const handler: AnyFn = cfg.emailAndPassword.sendResetPassword;

      await expect(
        handler({ user: { email: "" }, url: "", token: "" }, {} as any)
      ).resolves.toBeUndefined();

      expect(mockTempEmailSend).toHaveBeenCalledTimes(1);
      const payload = mockTempEmailSend.mock.calls[0][0];
      expect(payload.to).toBe("");
      expect(payload.text).toContain("");
    });

    test("sendVerificationEmail handles empty strings gracefully", async () => {
      await importModule();
      const cfg = betterAuthCallArgs[0];
      const handler: AnyFn = cfg.emailVerification.sendVerificationEmail;

      await expect(
        handler({ user: { email: "" }, url: "", token: "" }, {} as any)
      ).resolves.toBeUndefined();

      expect(mockTempEmailSend).toHaveBeenCalledTimes(1);
      const payload = mockTempEmailSend.mock.calls[0][0];
      expect(payload.to).toBe("");
      expect(payload.text).toContain("");
    });
  });
});
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createServer } from "../../server.js";
import { WEB_TEST_PASSWORD, createWebUser } from "./helpers/authHelper.js";
import { cleanupTestData } from "./helpers/testSetup.js";

// The module reaches for SES at import; the two-factor suite stubs it the same way.
vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

const APP_SCHEME = "flexiday://";

/**
 * The origin check as the phone app meets it: `expo-origin` stands in for the
 * `Origin` header and has to name a scheme TRUSTED_ORIGINS carries.
 */
describe("expo origin", () => {
  let app: Express;
  let email: string;

  const signIn = () =>
    request(app).post("/api/auth/sign-in/email").send({ email, password: WEB_TEST_PASSWORD });

  beforeAll(async () => {
    await cleanupTestData();
    app = createServer();
    ({ email } = await createWebUser("Expo Origin Subject"));
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("signs in a request whose expo origin is the app's scheme", async () => {
    const res = await signIn().set("expo-origin", APP_SCHEME);

    expect(res.status).toBe(200);
    expect(res.body.user?.email).toBe(email);
  });

  it("refuses a request whose expo origin is another app's scheme", async () => {
    const res = await signIn().set("expo-origin", "notflexiday://");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("INVALID_ORIGIN");
  });

  it("leaves a browser-shaped sign-in carrying no expo origin alone", async () => {
    const withoutOrigin = await signIn();
    expect(withoutOrigin.status).toBe(200);

    const fromTheFrontend = await signIn().set("Origin", "http://localhost:3000");
    expect(fromTheFrontend.status).toBe(200);
  });

  it("lets a real Origin header win over the expo one", async () => {
    // What keeps the expo header an input to the origin check rather than a
    // way to talk past it from a browser.
    const res = await signIn()
      .set("Origin", "http://localhost:3000")
      .set("expo-origin", "notflexiday://");

    expect(res.status).toBe(200);
  });

  it("does not serve the plugin's authorization proxy", async () => {
    const res = await request(app)
      .get("/api/auth/expo-authorization-proxy")
      .query({ authorizationURL: "https://accounts.google.com/o/oauth2/auth?state=abc" });

    expect(res.status).toBe(404);
  });
});

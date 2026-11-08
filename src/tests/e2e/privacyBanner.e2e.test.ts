import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { config } from "../../config.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { cleanupTestData, createTestUser } from "./helpers/testSetup.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

const DAY = 24 * 60 * 60 * 1000;
const OFF = { assistantEnabled: false, aiConnectionsEnabled: false, previewOrganizationIds: [] };

describe("the Privacy Policy banner", () => {
  let api: LoopbackServer;
  let aliceCookie: string;
  let bobCookie: string;
  let carolCookie: string;

  const launch = (from: Date | null, aiConnectionsEnabled = true) => {
    config.aiFeatures = { ...OFF, aiConnectionsEnabled };
    config.privacyBanner = { from };
  };

  const banner = (cookie: string) =>
    request(api.url).get("/api/ai-features/privacy-banner").set("Cookie", cookie);
  const dismiss = (cookie: string) =>
    request(api.url).post("/api/ai-features/privacy-banner/dismiss").set("Cookie", cookie);

  beforeAll(async () => {
    await cleanupTestData();
    const alice = await createTestUser("banner-alice@test.com", "Banner Alice", "x");
    const bob = await createTestUser("banner-bob@test.com", "Banner Bob", "x");
    const carol = await createTestUser("banner-carol@test.com", "Banner Carol", "x");
    aliceCookie = await authCookieFor(alice.id);
    bobCookie = await authCookieFor(bob.id);
    carolCookie = await authCookieFor(carol.id);
    api = await listenOnLoopback(createServer());
  });

  afterEach(() => {
    config.aiFeatures = OFF;
    config.privacyBanner = { from: null };
  });

  afterAll(async () => {
    await api?.close();
    await cleanupTestData();
  });

  it("stays hidden while AI connections is off, even with a start date", async () => {
    launch(new Date(Date.now() - DAY), false);
    const res = await banner(aliceCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ show: false });
  });

  it("stays hidden for a preview organization's members while the switch is off", async () => {
    config.aiFeatures = {
      ...OFF,
      previewOrganizationIds: ["00000000-0000-4000-8000-000000000001"],
    };
    config.privacyBanner = { from: new Date(Date.now() - DAY) };
    expect((await banner(aliceCookie)).body).toEqual({ show: false });
  });

  it("stays hidden with AI connections on and no start date", async () => {
    launch(null);
    expect((await banner(aliceCookie)).body).toEqual({ show: false });
  });

  it("stays hidden before its start date", async () => {
    launch(new Date(Date.now() + DAY));
    expect((await banner(aliceCookie)).body).toEqual({ show: false });
  });

  it("shows to every user for 30 days from its start date", async () => {
    launch(new Date(Date.now() - 29 * DAY));
    expect((await banner(aliceCookie)).body).toEqual({ show: true });
    expect((await banner(bobCookie)).body).toEqual({ show: true });

    launch(new Date(Date.now() - 30 * DAY - 60_000));
    expect((await banner(aliceCookie)).body).toEqual({ show: false });
  });

  it("stays dismissed for the user who dismissed it, and only for them", async () => {
    launch(new Date(Date.now() - DAY));

    const res = await dismiss(carolCookie);
    expect(res.status).toBe(204);
    expect((await banner(carolCookie)).body).toEqual({ show: false });
    expect((await banner(bobCookie)).body).toEqual({ show: true });

    expect((await dismiss(carolCookie)).status).toBe(204);
    expect((await banner(carolCookie)).body).toEqual({ show: false });
  });

  it("shows again when a later update moves the start date past the dismissal", async () => {
    launch(new Date(Date.now() - DAY));
    await dismiss(aliceCookie).expect(204);
    expect((await banner(aliceCookie)).body).toEqual({ show: false });

    launch(new Date(Date.now() + 1000));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await banner(aliceCookie)).body).toEqual({ show: true });
  });

  it("refuses both routes without a session", async () => {
    expect((await request(api.url).get("/api/ai-features/privacy-banner")).status).toBe(401);
    expect((await request(api.url).post("/api/ai-features/privacy-banner/dismiss")).status).toBe(
      401
    );
  });
});

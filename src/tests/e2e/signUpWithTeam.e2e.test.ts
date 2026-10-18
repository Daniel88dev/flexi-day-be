import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { account, user } from "../../db/schema/auth-schema.js";
import { groups } from "../../db/schema/group-schema.js";
import { organizations } from "../../db/schema/organization-schema.js";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { WEB_TEST_PASSWORD, authCookieFor, createWebUser } from "./helpers/authHelper.js";
import { cleanupTestData } from "./helpers/testSetup.js";

vi.mock("../../services/email/index.js", () => ({
  emailSender: { sendTemplated: () => Promise.resolve() },
}));

// Sign-up runs the Have I Been Pwned check, an outbound call. Answered here so
// the suite runs offline.
const realFetch = globalThis.fetch;
vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  if (!url.startsWith("https://api.pwnedpasswords.com/range/")) return realFetch(input, init);
  return Promise.resolve(new Response("", { status: 200 }));
});

/**
 * The public sign-up form's endpoint. A sign-up for an address that already
 * has an account must leave that account alone, and must answer the same with
 * or without a team name.
 */
describe("sign up with team", () => {
  let server: LoopbackServer;

  const signUp = (body: { email: string; password?: string; teamName?: string }) =>
    request(server.url)
      .post("/api/auth/sign-up-with-team")
      .send({ name: "Someone Else", password: "another-passphrase-17", ...body });

  const signInStatus = async (email: string) =>
    (
      await request(server.url)
        .post("/api/auth/sign-in/email")
        .send({ email, password: WEB_TEST_PASSWORD })
    ).status;

  const sessionUserId = async (cookie: string) => {
    const res = await request(server.url).get("/api/auth/get-session").set("Cookie", cookie);
    return (res.body as { user?: { id: string } } | null)?.user?.id;
  };

  beforeAll(async () => {
    await cleanupTestData();
    server = await listenOnLoopback(createServer());
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
    vi.restoreAllMocks();
  });

  it("leaves an existing teamless account and its data untouched when the sign-up names a team", async () => {
    const existing = await createWebUser("Existing Owner");
    const cookie = await authCookieFor(existing.id);

    await signUp({ email: existing.email, teamName: "Some Team" });

    const rows = await db.select().from(user).where(eq(user.id, existing.id));
    expect(rows).toHaveLength(1);
    const credentials = await db.select().from(account).where(eq(account.userId, existing.id));
    expect(credentials).toHaveLength(1);
    expect(await sessionUserId(cookie)).toBe(existing.id);
    expect(await signInStatus(existing.email)).toBe(200);
  });

  it("answers a duplicate sign-up with a team name exactly like one without", async () => {
    const withoutTeam = await createWebUser("Existing Without");
    const withTeam = await createWebUser("Existing With");

    const plain = await signUp({ email: withoutTeam.email });
    const named = await signUp({ email: withTeam.email, teamName: "Some Team" });

    expect(named.status).toBe(plain.status);
    expect(Object.keys(named.body as object).sort()).toEqual(
      Object.keys(plain.body as object).sort()
    );
    expect(named.body).toMatchObject({ token: null, group: null });
    expect(named.headers["set-cookie"]).toBeUndefined();
    expect(await signInStatus(withoutTeam.email)).toBe(200);
    expect(await signInStatus(withTeam.email)).toBe(200);
  });

  it("refuses a password longer than better-auth accepts as invalid input, creating nothing", async () => {
    const email = `long-password-${uuidv4()}@sign-up-team.test`;

    const res = await signUp({ email, password: "p".repeat(129), teamName: "Fresh Team" });

    expect(res.status).toBe(422);
    expect(await db.select().from(user).where(eq(user.email, email))).toHaveLength(0);
  });

  it("still creates the user, organization and group for a genuine new sign-up with a team", async () => {
    const email = `newcomer-${uuidv4()}@sign-up-team.test`;

    const res = await signUp({ email, teamName: "Fresh Team" });

    expect(res.status).toBe(201);
    const created = await db.select().from(user).where(eq(user.email, email));
    expect(created).toHaveLength(1);
    const userId = created[0]!.id;
    const orgs = await db.select().from(organizations).where(eq(organizations.ownerUserId, userId));
    expect(orgs).toHaveLength(1);
    const owned = await db.select().from(groups).where(eq(groups.managerUserId, userId));
    expect(owned.map((g) => g.groupName)).toEqual(["Fresh Team"]);
  });
});

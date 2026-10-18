import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { setupTestEnvironment, cleanupTestData, type TestContext } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { db } from "../../db/db.js";
import { calendarSync, calendarSyncScope } from "../../db/schema/calendar-sync-schema.js";
import {
  calendarConnection,
  calendarProvider,
} from "../../db/schema/calendar-connection-schema.js";
import { encryptOAuthToken } from "../../utils/oauthTokens.js";

const types = [{ type: "VACATION", color: "blue" }];

describe("calendar-sync config: zone and the Group events and Birthdays settings", () => {
  let context: TestContext;
  let server: LoopbackServer;
  let cookie: string;

  const create = (body: Record<string, unknown>) =>
    request(server.url)
      .post("/api/calendar-sync")
      .set("Cookie", cookie)
      .send({ name: "Mine", types, ...body });

  const update = (id: string, body: Record<string, unknown>) =>
    request(server.url)
      .put(`/api/calendar-sync/${id}`)
      .set("Cookie", cookie)
      .send({ name: "Mine", types, ...body });

  const listed = async (id: string) => {
    const res = await request(server.url).get("/api/calendar-sync").set("Cookie", cookie);
    expect(res.status).toBe(200);
    return (res.body as { id: string }[]).find((config) => config.id === id);
  };

  beforeAll(async () => {
    context = await setupTestEnvironment();
    server = await listenOnLoopback(createServer());
    cookie = await authCookieFor(context.user1.id);
  });

  afterAll(async () => {
    await server.close();
    await cleanupTestData();
  });

  it("creates a feed in Europe/Prague with Group events and Birthdays off when the body names neither", async () => {
    const res = await create({});

    expect(res.status).toBe(201);
    const expected = {
      timeZone: "Europe/Prague",
      includeGroupEvents: false,
      groupEventsColor: null,
      includeBirthdays: false,
      birthdaysColor: null,
    };
    expect(res.body).toMatchObject(expected);
    expect(await listed(res.body.id)).toMatchObject(expected);
  });

  it("stores the zone and the four settings a create names and returns them on every read", async () => {
    const settings = {
      timeZone: "America/New_York",
      includeGroupEvents: true,
      groupEventsColor: "teal",
      includeBirthdays: true,
      birthdaysColor: "rose",
    };

    const res = await create(settings);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject(settings);
    expect(await listed(res.body.id)).toMatchObject(settings);
    const detail = await request(server.url)
      .get(`/api/calendar-sync/${res.body.id}`)
      .set("Cookie", cookie);
    expect(detail.body).toMatchObject(settings);
  });

  it("replaces the settings an update names and keeps the ones it leaves out", async () => {
    const { body: created } = await create({
      timeZone: "America/New_York",
      includeGroupEvents: true,
      groupEventsColor: "teal",
    });

    const changed = await update(created.id, {
      timeZone: "Asia/Tokyo",
      includeGroupEvents: false,
      groupEventsColor: null,
      includeBirthdays: true,
      birthdaysColor: "plum",
    });
    const untouched = await update(created.id, { name: "Renamed" });

    const expected = {
      timeZone: "Asia/Tokyo",
      includeGroupEvents: false,
      groupEventsColor: null,
      includeBirthdays: true,
      birthdaysColor: "plum",
    };
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject(expected);
    expect(untouched.status).toBe(200);
    expect(untouched.body).toMatchObject({ ...expected, name: "Renamed" });
    expect(await listed(created.id)).toMatchObject({ ...expected, name: "Renamed" });
  });

  it("answers 422 for a zone that is not an IANA name, on create and on update", async () => {
    const { body: created } = await create({});

    for (const timeZone of ["+01:00", "Mars/Olympus", ""]) {
      expect((await create({ timeZone })).status).toBe(422);
      expect((await update(created.id, { timeZone })).status).toBe(422);
    }
    expect((await listed(created.id))?.timeZone).toBe("Europe/Prague");
  });

  it("answers 422 for a colour outside the palette", async () => {
    expect((await create({ groupEventsColor: "#ff0000" })).status).toBe(422);
    expect((await create({ birthdaysColor: "pink" })).status).toBe(422);
  });

  it("reads back Europe/Prague for a config written without a zone", async () => {
    const id = uuidv4();
    await db.insert(calendarSync).values({
      id,
      userId: context.user1.id,
      name: "Written before zones",
      scope: calendarSyncScope.Me,
      token: `flx_live_${uuidv4().replaceAll("-", "")}`,
    });

    expect(await listed(id)).toMatchObject({ timeZone: "Europe/Prague" });
  });

  it("marks a connected target due when an update moves its zone, and only then", async () => {
    const connectionId = uuidv4();
    await db.insert(calendarConnection).values({
      id: connectionId,
      userId: context.user1.id,
      provider: calendarProvider.Google,
      refreshTokenEnc: await encryptOAuthToken("fake-refresh-google-fake-code"),
      grantedScopes: "calendar",
    });
    const { body: created } = await create({});
    await db
      .update(calendarSync)
      .set({ connectionId, syncDueAt: null })
      .where(eq(calendarSync.id, created.id));
    const due = async () =>
      (await db.select().from(calendarSync).where(eq(calendarSync.id, created.id)))[0]!.syncDueAt;

    await update(created.id, { timeZone: "Europe/Prague" });
    expect(await due()).toBeNull();

    const moved = await update(created.id, { timeZone: "Europe/London" });
    expect(moved.status).toBe(200);
    expect(moved.body.target).toMatchObject({ timeZone: "Europe/London" });
    expect(await due()).toBeInstanceOf(Date);
  });
});

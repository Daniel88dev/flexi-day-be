import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addLeave,
  addMember,
  dayIn,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";

const YEAR = new Date().getUTCFullYear() + 1;
const day = (d: number) => dayIn(YEAR, 3, d);

type FeedEvent = { uid: string; summary: string; description: string | null; categories: string };

/** The feed's events by UID, lines unfolded. */
const parseFeed = (body: string): Map<string, FeedEvent> => {
  const unfolded = body.replace(/\r?\n[ \t]/g, "");
  const events = new Map<string, FeedEvent>();
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const field = (name: string): string | null => {
      const match = block.match(new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, "m"));
      return match ? match[1]!.trim() : null;
    };
    const uid = field("UID")!;
    events.set(uid.replace(/@flexiday$/, ""), {
      uid,
      summary: field("SUMMARY") ?? "",
      description: field("DESCRIPTION"),
      categories: field("CATEGORIES") ?? "",
    });
  }
  return events;
};

/**
 * Tom is a plain member of Team. Vera holds View, Ann approves Team. Each owns
 * a team feed over Team; Tom owns a personal feed. A team feed URL is a bearer
 * link, so nobody's team feed hands out another person's Sick or note.
 */
describe("Team calendar feeds carry only what a teammate may see", () => {
  let server: LoopbackServer;
  let tom: { id: string };
  let vera: { id: string };
  let ann: { id: string };
  let tomSick: string;
  let tomVacation: string;
  let tomSickDay: string;
  let veraSick: string;

  const tokenOf = (feedUrl: string) =>
    feedUrl.match(/\/calendars\/(flx_live_[a-f0-9]{40})\.ics$/)![1]!;

  const createFeed = async (ownerId: string, body: Record<string, unknown>): Promise<string> => {
    const created = await request(server.url)
      .post("/api/calendar-sync")
      .set("Cookie", await authCookieFor(ownerId))
      .send(body)
      .expect(201);
    return tokenOf(created.body.feedUrl as string);
  };

  const fetchFeed = async (token: string): Promise<Map<string, FeedEvent>> => {
    const response = await request(server.url).get(`/calendars/${token}.ics`).expect(200);
    return parseFeed(response.text || String(response.body));
  };

  const VACATION = { type: "VACATION", color: "blue" };
  const SICK = { type: "SICK", color: "rose" };
  const SICK_DAY = { type: "SICK_DAY", color: "amber" };
  const TYPES = [VACATION, SICK, SICK_DAY];

  let teamGroupId: string;
  const teamFeed = (name: string) => ({
    name,
    scope: "TEAM",
    teamIds: [teamGroupId],
    types: TYPES,
  });

  beforeAll(async () => {
    await resetReportData();
    server = await listenOnLoopback(createServer());

    const mia = await makeUser("Mia Manager");
    tom = await makeUser("Tom Teammate");
    vera = await makeUser("Vera Viewer");
    ann = await makeUser("Ann Approver");
    teamGroupId = await makeGroup("Team", mia.id);
    await upsertSubscription((await ensureOrganizationForUser(mia.id)).id, {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });
    await addMember(teamGroupId, tom.id);
    await addMember(teamGroupId, vera.id, { viewAccess: true });
    await addMember(teamGroupId, ann.id, { viewAccess: true, approverAccess: true });

    tomSick = await addLeave(teamGroupId, tom.id, day(2), {
      type: CalendarRecordType.Sick,
      note: "tom-sick-note",
    });
    tomVacation = await addLeave(teamGroupId, tom.id, day(9), { note: "tom-vacation-note" });
    tomSickDay = await addLeave(teamGroupId, tom.id, day(11), {
      type: CalendarRecordType.SickDay,
    });
    veraSick = await addLeave(teamGroupId, vera.id, day(16), {
      type: CalendarRecordType.Sick,
      note: "vera-own-note",
    });
  });

  afterAll(async () => {
    await server?.close();
    await resetReportData();
  });

  it("shows a teammate's Sick as Away with no note on a View member's team feed", async () => {
    const events = await fetchFeed(await createFeed(vera.id, teamFeed("Vera team")));

    const sick = events.get(tomSick)!;
    expect(sick.summary).toBe("Tom Teammate — Away");
    expect(sick.categories).toBe("Away");
    expect(sick.description).toBeNull();
  });

  it("drops a teammate's note from every event on a View member's team feed", async () => {
    const events = await fetchFeed(await createFeed(vera.id, teamFeed("Vera notes")));

    expect(events.get(tomVacation)!.summary).toBe("Tom Teammate — Vacation");
    expect(events.get(tomVacation)!.description).toBeNull();
    for (const event of events.values()) {
      expect(event.description ?? "").not.toMatch(/tom-/);
    }
  });

  it("redacts teammates on an approver's team feed too, because the URL is a bearer link", async () => {
    const events = await fetchFeed(await createFeed(ann.id, teamFeed("Ann team")));

    expect(events.get(tomSick)!.summary).toBe("Tom Teammate — Away");
    expect(events.get(tomSick)!.categories).toBe("Away");
    expect(events.get(tomSick)!.description).toBeNull();
    expect(events.get(tomVacation)!.description).toBeNull();
    expect(events.get(veraSick)!.summary).toBe("Vera Viewer — Away");
    expect(events.get(veraSick)!.description).toBeNull();
  });

  it("labels a teammate's Away in the feed owner's language", async () => {
    const token = await createFeed(vera.id, teamFeed("Vera Czech"));
    await request(server.url)
      .put("/api/users/me/settings")
      .set("Cookie", await authCookieFor(vera.id))
      .send({ language: "cs" })
      .expect(200);

    const events = await fetchFeed(token);
    await request(server.url)
      .put("/api/users/me/settings")
      .set("Cookie", await authCookieFor(vera.id))
      .send({ language: "en" })
      .expect(200);

    expect(events.get(tomSick)!.summary).toBe("Tom Teammate — Pryč");
    expect(events.get(tomSick)!.categories).toBe("Pryč");
  });

  it("carries a teammate's Away on a Sick-only team feed", async () => {
    const events = await fetchFeed(
      await createFeed(vera.id, { ...teamFeed("Vera sick only"), types: [SICK] })
    );

    expect(events.get(tomSick)!.summary).toBe("Tom Teammate — Away");
    expect(events.get(tomSick)!.description).toBeNull();
    expect(events.has(tomVacation)).toBe(false);
  });

  it("leaves a teammate's Away off a team feed without the Sick toggle", async () => {
    const events = await fetchFeed(
      await createFeed(vera.id, { ...teamFeed("Vera no sick"), types: [VACATION, SICK_DAY] })
    );

    expect(events.has(tomSick)).toBe(false);
    expect(events.has(veraSick)).toBe(false);
    expect(events.get(tomVacation)!.summary).toBe("Tom Teammate — Vacation");
  });

  // The owner's own rows and every other type stay as they are.

  it("keeps the feed owner's own Sick and note on their team feed", async () => {
    const events = await fetchFeed(await createFeed(vera.id, teamFeed("Vera own")));

    expect(events.get(veraSick)!.summary).toBe("Vera Viewer — Sick");
    expect(events.get(veraSick)!.description).toBe("vera-own-note");
  });

  it("keeps a teammate's Sick day as Sick day", async () => {
    const events = await fetchFeed(await createFeed(vera.id, teamFeed("Vera sick day")));

    expect(events.get(tomSickDay)!.summary).toBe("Tom Teammate — Sick day");
  });

  it("keeps the owner's own Sick and note on a personal feed", async () => {
    const events = await fetchFeed(
      await createFeed(tom.id, { name: "Mine", scope: "ME", teamIds: [], types: TYPES })
    );

    expect(events.get(tomSick)!.summary).toBe("Tom Teammate — Sick");
    expect(events.get(tomSick)!.categories).toBe("Sick");
    expect(events.get(tomSick)!.description).toBe("tom-sick-note");
    expect(events.get(tomVacation)!.description).toBe("tom-vacation-note");
  });
});

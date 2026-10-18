import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import {
  setupTestEnvironment,
  cleanupTestData,
  createTestGroup,
  type TestContext,
  type TestGroup,
} from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { db } from "../../db/db.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { vacation, CalendarRecordType } from "../../db/schema/vacation-schema.js";
import { v4 as uuidv4 } from "uuid";

const workingDayFromNow = (offset: number) => {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + offset);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
};

describe("Team feeds follow the owner's live membership", () => {
  let context: TestContext;
  let server: LoopbackServer;
  let otherGroup: TestGroup;
  let ownerCookie: string;
  let managerCookie: string;
  let teamFeedId: string;
  let teamFeedToken: string;
  let meFeedToken: string;
  const leftGroupVacationId = uuidv4();
  const keptGroupVacationId = uuidv4();
  const ownVacationId = uuidv4();

  const addMembership = (userId: string, groupId: string) =>
    db.insert(groupUsers).values({
      id: uuidv4(),
      userId,
      groupId,
      viewAccess: true,
      adminAccess: false,
      approverAccess: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

  const approvedVacation = (id: string, userId: string, groupId: string, day: string) =>
    db.insert(vacation).values({
      id,
      userId,
      groupId,
      requestId: uuidv4(),
      requestedDay: day,
      vacationType: CalendarRecordType.Vacation,
      approvedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

  const tokenOf = (feedUrl: string) =>
    feedUrl.match(/\/calendars\/(flx_live_[a-f0-9]{40})\.ics$/)![1]!;

  const fetchFeed = async (token: string) => {
    const response = await request(server.url).get(`/calendars/${token}.ics`).expect(200);
    return response.text || String(response.body);
  };

  beforeAll(async () => {
    context = await setupTestEnvironment();
    server = await listenOnLoopback(createServer());
    otherGroup = await createTestGroup("Other Group", context.user1.id);
    ownerCookie = await authCookieFor(context.user2.id);
    managerCookie = await authCookieFor(context.user1.id);

    await addMembership(context.user2.id, context.group.id);
    await addMembership(context.user2.id, otherGroup.id);

    await approvedVacation(
      leftGroupVacationId,
      context.user1.id,
      context.group.id,
      workingDayFromNow(14)
    );
    await approvedVacation(
      keptGroupVacationId,
      context.user1.id,
      otherGroup.id,
      workingDayFromNow(21)
    );
    await approvedVacation(
      ownVacationId,
      context.user2.id,
      context.group.id,
      workingDayFromNow(28)
    );

    const team = await request(server.url)
      .post("/api/calendar-sync")
      .set("Cookie", ownerCookie)
      .send({
        name: "Both teams",
        scope: "TEAM",
        teamIds: [context.group.id, otherGroup.id],
        types: [{ type: "VACATION", color: "blue" }],
      })
      .expect(201);
    teamFeedId = team.body.id;
    teamFeedToken = tokenOf(team.body.feedUrl);

    const me = await request(server.url)
      .post("/api/calendar-sync")
      .set("Cookie", ownerCookie)
      .send({
        name: "Mine",
        scope: "ME",
        teamIds: [],
        types: [{ type: "VACATION", color: "blue" }],
      })
      .expect(201);
    meFeedToken = tokenOf(me.body.feedUrl);
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  it("carries every selected group while the owner is a member of each", async () => {
    const body = await fetchFeed(teamFeedToken);
    expect(body).toContain(`UID:${leftGroupVacationId}@flexiday`);
    expect(body).toContain(`UID:${keptGroupVacationId}@flexiday`);
    expect(body).toContain(`UID:${ownVacationId}@flexiday`);
  });

  it("drops a group's records on the next fetch once the owner is removed from it", async () => {
    await request(server.url)
      .delete(`/api/group-user/${context.group.id}/${context.user2.id}`)
      .set("Cookie", managerCookie)
      .expect(200);

    const body = await fetchFeed(teamFeedToken);
    expect(body).not.toContain(`UID:${leftGroupVacationId}@flexiday`);
    expect(body).not.toContain(`UID:${ownVacationId}@flexiday`);
    expect(body).toContain(`UID:${keptGroupVacationId}@flexiday`);

    const config = await request(server.url)
      .get(`/api/calendar-sync/${teamFeedId}`)
      .set("Cookie", ownerCookie)
      .expect(200);
    expect([...config.body.teamIds].sort()).toEqual([context.group.id, otherGroup.id].sort());
  });

  it("keeps the owner's own records on a personal feed after they leave the group", async () => {
    const body = await fetchFeed(meFeedToken);
    expect(body).toContain(`UID:${ownVacationId}@flexiday`);
    expect(body).not.toContain(`UID:${leftGroupVacationId}@flexiday`);
  });

  it("restores the group once the owner re-joins, without editing the feed", async () => {
    await addMembership(context.user2.id, context.group.id);

    const body = await fetchFeed(teamFeedToken);
    expect(body).toContain(`UID:${leftGroupVacationId}@flexiday`);
    expect(body).toContain(`UID:${keptGroupVacationId}@flexiday`);
    expect(body).toContain(`UID:${ownVacationId}@flexiday`);
  });
});

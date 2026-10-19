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

describe("Editing a team feed after its owner left one of its groups", () => {
  let context: TestContext;
  let server: LoopbackServer;
  let keptGroup: TestGroup;
  let foreignGroup: TestGroup;
  let ownerCookie: string;
  let managerCookie: string;
  let feedId: string;
  let feedToken: string;
  const leftGroupVacationId = uuidv4();
  const keptGroupVacationId = uuidv4();

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

  const leaveLeftGroup = () =>
    request(server.url)
      .delete(`/api/group-user/${context.group.id}/${context.user2.id}`)
      .set("Cookie", managerCookie)
      .expect(200);

  const update = (body: { name: string; scope: "ME" | "TEAM"; teamIds: string[] }) =>
    request(server.url)
      .put(`/api/calendar-sync/${feedId}`)
      .set("Cookie", ownerCookie)
      .send({ ...body, types: [{ type: "VACATION", color: "blue" }] });

  const storedTeamIds = async () => {
    const config = await request(server.url)
      .get(`/api/calendar-sync/${feedId}`)
      .set("Cookie", ownerCookie)
      .expect(200);
    return [...(config.body.teamIds as string[])].sort();
  };

  const fetchFeed = async () => {
    const response = await request(server.url).get(`/calendars/${feedToken}.ics`).expect(200);
    return response.text || String(response.body);
  };

  const bothGroups = () => [context.group.id, keptGroup.id].sort();

  beforeAll(async () => {
    context = await setupTestEnvironment();
    server = await listenOnLoopback(createServer());
    keptGroup = await createTestGroup("Kept Group", context.user1.id);
    foreignGroup = await createTestGroup("Foreign Group", context.user1.id);
    ownerCookie = await authCookieFor(context.user2.id);
    managerCookie = await authCookieFor(context.user1.id);

    await addMembership(context.user2.id, context.group.id);
    await addMembership(context.user2.id, keptGroup.id);

    await approvedVacation(
      leftGroupVacationId,
      context.user1.id,
      context.group.id,
      workingDayFromNow(14)
    );
    await approvedVacation(
      keptGroupVacationId,
      context.user1.id,
      keptGroup.id,
      workingDayFromNow(21)
    );

    const created = await request(server.url)
      .post("/api/calendar-sync")
      .set("Cookie", ownerCookie)
      .send({
        name: "Both teams",
        scope: "TEAM",
        teamIds: [context.group.id, keptGroup.id],
        types: [{ type: "VACATION", color: "blue" }],
      })
      .expect(201);
    feedId = created.body.id;
    feedToken = created.body.feedUrl.match(/\/calendars\/(flx_live_[a-f0-9]{40})\.ics$/)![1]!;

    await leaveLeftGroup();
  });

  afterAll(async () => {
    await server?.close();
    await cleanupTestData();
  });

  it("saves a rename with the stored selection and keeps the left group stored", async () => {
    const response = await update({ name: "Renamed", scope: "TEAM", teamIds: bothGroups() });
    expect(response.status).toBe(200);
    expect(response.body.name).toBe("Renamed");
    expect(await storedTeamIds()).toEqual(bothGroups());
  });

  it("saves a switch to only my records with the stored selection", async () => {
    const response = await update({ name: "Renamed", scope: "ME", teamIds: bothGroups() });
    expect(response.status).toBe(200);
    expect(response.body.scope).toBe("ME");
    expect(await storedTeamIds()).toEqual(bothGroups());
  });

  it("still refuses a group the owner never belonged to", async () => {
    const response = await update({
      name: "Renamed",
      scope: "TEAM",
      teamIds: [...bothGroups(), foreignGroup.id],
    });
    expect(response.status).toBe(403);
    expect(await storedTeamIds()).toEqual(bothGroups());
  });

  it("keeps the left group's records out of the feed after the edit", async () => {
    await update({ name: "Renamed", scope: "TEAM", teamIds: bothGroups() }).expect(200);

    const body = await fetchFeed();
    expect(body).not.toContain(`UID:${leftGroupVacationId}@flexiday`);
    expect(body).toContain(`UID:${keptGroupVacationId}@flexiday`);
  });

  it("restores the left group on the next fetch once the owner re-joins", async () => {
    await addMembership(context.user2.id, context.group.id);

    const body = await fetchFeed();
    expect(body).toContain(`UID:${leftGroupVacationId}@flexiday`);
    expect(body).toContain(`UID:${keptGroupVacationId}@flexiday`);
  });

  it("refuses to add back a left group the feed no longer stores", async () => {
    await leaveLeftGroup();
    await update({ name: "Renamed", scope: "TEAM", teamIds: [keptGroup.id] }).expect(200);
    expect(await storedTeamIds()).toEqual([keptGroup.id]);

    const response = await update({ name: "Renamed", scope: "TEAM", teamIds: bothGroups() });
    expect(response.status).toBe(403);
    expect(await storedTeamIds()).toEqual([keptGroup.id]);
  });

  it("refuses a group the owner has left when creating a feed", async () => {
    const response = await request(server.url)
      .post("/api/calendar-sync")
      .set("Cookie", ownerCookie)
      .send({
        name: "New feed",
        scope: "TEAM",
        teamIds: bothGroups(),
        types: [{ type: "VACATION", color: "blue" }],
      });
    expect(response.status).toBe(403);
  });
});

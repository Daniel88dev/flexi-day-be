import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { createServer } from "../../server.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { authCookieFor } from "./helpers/authHelper.js";
import {
  addLeave,
  addMember,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { saveBirthday } from "../../services/birthday/birthdayServices.js";
import { db } from "../../db/db.js";
import { groupEvents } from "../../db/schema/group-event-schema.js";

const workingDayFromNow = (offset: number) => {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + offset);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
};

const PRIVATE_NOTE = "teammate-private-note";

type OwnerAccess = { viewAccess: boolean; adminAccess?: boolean };

describe("Team feeds honour the owner's View access", () => {
  let server: LoopbackServer;
  let manager: { id: string };
  let owner: { id: string };
  let teammate: { id: string };
  let groupId: string;
  let teamFeedToken: string;
  let teamFeedId: string;
  let teammateVacationId: string;
  let ownerVacationId: string;
  let groupEventId: string;

  const tokenOf = (feedUrl: string) =>
    feedUrl.match(/\/calendars\/(flx_live_[a-f0-9]{40})\.ics$/)![1]!;

  const fetchFeed = async (token: string) => {
    const response = await request(server.url).get(`/calendars/${token}.ics`).expect(200);
    return response.text || String(response.body);
  };

  const setOwnerAccess = async ({ viewAccess, adminAccess = false }: OwnerAccess) =>
    request(server.url)
      .put("/api/group-user")
      .set("Cookie", await authCookieFor(manager.id))
      .send({
        groupId,
        data: [
          {
            userId: owner.id,
            viewAccess,
            adminAccess,
            approverAccess: false,
            controlledUser: true,
          },
        ],
      })
      .expect(200);

  const teamFeedBody = (name: string) => ({
    name,
    scope: "TEAM",
    teamIds: [groupId],
    types: [{ type: "VACATION", color: "blue" }],
    includeBirthdays: true,
    includeGroupEvents: true,
  });

  beforeAll(async () => {
    await resetReportData();
    server = await listenOnLoopback(createServer());

    manager = await makeUser("Manager");
    owner = await makeUser("Rita Owner");
    teammate = await makeUser("Tom Teammate");
    groupId = await makeGroup("Engineering", manager.id);
    await upsertSubscription((await ensureOrganizationForUser(manager.id)).id, {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });
    await addMember(groupId, owner.id, { viewAccess: true });
    await addMember(groupId, teammate.id);

    teammateVacationId = await addLeave(groupId, teammate.id, workingDayFromNow(14), {
      note: PRIVATE_NOTE,
    });
    ownerVacationId = await addLeave(groupId, owner.id, workingDayFromNow(21));
    await saveBirthday(teammate.id, { month: 3, day: 14, year: 1990, shared: true });
    groupEventId = uuidv4();
    await db.insert(groupEvents).values({
      id: groupEventId,
      groupId,
      title: "Offsite",
      startDate: workingDayFromNow(30),
      endDate: workingDayFromNow(30),
    });

    const created = await request(server.url)
      .post("/api/calendar-sync")
      .set("Cookie", await authCookieFor(owner.id))
      .send(teamFeedBody("Team"))
      .expect(201);
    teamFeedToken = tokenOf(created.body.feedUrl);
    teamFeedId = created.body.id;
  });

  afterAll(async () => {
    await server?.close();
    await resetReportData();
  });

  it("carries the group's records while the owner's View is on", async () => {
    const body = await fetchFeed(teamFeedToken);
    expect(body).toContain(`UID:${teammateVacationId}@flexiday`);
    expect(body).toContain(PRIVATE_NOTE);
    expect(body).toContain(`UID:bd-${teammate.id}@flexiday`);
    expect(body).toContain(`UID:${ownerVacationId}@flexiday`);
    expect(body).toContain(`UID:ge-${groupEventId}@flexiday`);
  });

  it("stops carrying other members' records on the next fetch once View is switched off", async () => {
    await setOwnerAccess({ viewAccess: false });

    await request(server.url)
      .get("/api/vacation/calendar")
      .query({ year: 2026, month: 10, groupId })
      .set("Cookie", await authCookieFor(owner.id))
      .expect(403);

    const body = await fetchFeed(teamFeedToken);
    expect(body).not.toContain(`UID:${teammateVacationId}@flexiday`);
    expect(body).not.toContain(PRIVATE_NOTE);
    expect(body).not.toContain(`UID:bd-${teammate.id}@flexiday`);
    expect(body).toContain(`UID:${ownerVacationId}@flexiday`);
    expect(body).toContain(`UID:ge-${groupEventId}@flexiday`);
  });

  it("accepts a new team feed for a group without View and keeps it to the owner's own records", async () => {
    const created = await request(server.url)
      .post("/api/calendar-sync")
      .set("Cookie", await authCookieFor(owner.id))
      .send(teamFeedBody("Probe"))
      .expect(201);

    const body = await fetchFeed(tokenOf(created.body.feedUrl));
    expect(body).not.toContain(`UID:${teammateVacationId}@flexiday`);
    expect(body).not.toContain(PRIVATE_NOTE);
    expect(body).not.toContain(`UID:bd-${teammate.id}@flexiday`);
    expect(body).toContain(`UID:${ownerVacationId}@flexiday`);
    expect(body).toContain(`UID:ge-${groupEventId}@flexiday`);
  });

  it("lets the owner rename a team feed for a group without View and keeps it to their own records", async () => {
    await request(server.url)
      .put(`/api/calendar-sync/${teamFeedId}`)
      .set("Cookie", await authCookieFor(owner.id))
      .send(teamFeedBody("Renamed"))
      .expect(200);

    const body = await fetchFeed(teamFeedToken);
    expect(body).not.toContain(`UID:${teammateVacationId}@flexiday`);
    expect(body).toContain(`UID:${ownerVacationId}@flexiday`);
  });

  it("carries the group's records again once View is switched back on", async () => {
    await setOwnerAccess({ viewAccess: true });

    const body = await fetchFeed(teamFeedToken);
    expect(body).toContain(`UID:${teammateVacationId}@flexiday`);
    expect(body).toContain(`UID:bd-${teammate.id}@flexiday`);
  });

  it("carries the whole group for an owner with admin access and View off", async () => {
    await setOwnerAccess({ viewAccess: false, adminAccess: true });

    const body = await fetchFeed(teamFeedToken);
    expect(body).toContain(`UID:${teammateVacationId}@flexiday`);
    expect(body).toContain(`UID:bd-${teammate.id}@flexiday`);
  });
});

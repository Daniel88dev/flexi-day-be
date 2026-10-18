import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
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

const isoDay = (offset: number) => {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
};

describe("Dashboard summary counts follow the caller's View access", () => {
  let server: LoopbackServer;
  let viewer: { id: string };
  let member: { id: string };

  const summaryFor = async (userId: string) =>
    (
      await request(server.url)
        .get("/api/users/me/dashboard-summary")
        .set("Cookie", await authCookieFor(userId))
        .expect(200)
    ).body as { outTodayCount: number; upcomingNext14DaysCount: number; teamSize: number };

  beforeAll(async () => {
    await resetReportData();
    server = await listenOnLoopback(createServer());

    const manager = await makeUser("Manager");
    viewer = await makeUser("Vera Viewer");
    member = await makeUser("Mo Member");
    const teammate = await makeUser("Tom Teammate");
    const groupId = await makeGroup("Engineering", manager.id);
    await addMember(groupId, viewer.id, { viewAccess: true });
    await addMember(groupId, member.id);
    await addMember(groupId, teammate.id);

    await addLeave(groupId, teammate.id, isoDay(0));
    await addLeave(groupId, teammate.id, isoDay(3));
    await addLeave(groupId, member.id, isoDay(5));
  });

  afterAll(async () => {
    await server?.close();
    await resetReportData();
  });

  it("counts the whole group for a member with View", async () => {
    expect(await summaryFor(viewer.id)).toMatchObject({
      outTodayCount: 1,
      upcomingNext14DaysCount: 3,
      teamSize: 3,
    });
  });

  it("counts only the caller's own records for a member without View", async () => {
    expect(await summaryFor(member.id)).toMatchObject({
      outTodayCount: 0,
      upcomingNext14DaysCount: 1,
      teamSize: 1,
    });
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { createTestUser, cleanupTestData } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";

describe("user settings: dashboard calendar view", () => {
  let app: Express;
  let viewerId: string;
  let cookie: string;

  // Real group ids are not UUIDs, so the settings path must not assume one.
  const GROUP_ID = "Kq7Rz2mWb9XfT4nLp8VdC3sHy6JgA1eE";

  const getSettings = () => request(app).get("/api/users/me/settings").set("Cookie", cookie);
  const putSettings = (body: object) =>
    request(app).put("/api/users/me/settings").set("Cookie", cookie).send(body);

  beforeAll(async () => {
    await cleanupTestData();
    app = createServer();

    const owner = await createTestUser("calendar-owner@test.com", "Otto Owner", "password123");
    const viewer = await createTestUser("calendar-view@test.com", "Vera Viewer", "password123");
    viewerId = viewer.id;
    cookie = await authCookieFor(viewer.id);

    const organizationId = (await ensureOrganizationForUser(owner.id)).id;
    await db.insert(groups).values({
      id: GROUP_ID,
      organizationId,
      groupName: "Design",
      managerUserId: owner.id,
      mainApprovalUser: owner.id,
    });
    await db.insert(groupUsers).values({
      id: uuidv4(),
      userId: viewer.id,
      groupId: GROUP_ID,
      viewAccess: true,
      adminAccess: false,
      approverAccess: false,
      controlledUser: true,
    });
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  it("is LANES for a user who never set it", async () => {
    const res = await getSettings().expect(200);
    expect(res.body.dashboardCalendarView).toBe("LANES");
  });

  it("stores STRIPES and returns it, then switches back to LANES", async () => {
    const saved = await putSettings({ dashboardCalendarView: "STRIPES" }).expect(200);
    expect(saved.body.dashboardCalendarView).toBe("STRIPES");
    expect((await getSettings().expect(200)).body.dashboardCalendarView).toBe("STRIPES");

    await putSettings({ emailNotifications: false }).expect(200);
    expect((await getSettings().expect(200)).body.dashboardCalendarView).toBe("STRIPES");

    await putSettings({ dashboardCalendarView: "LANES" }).expect(200);
    expect((await getSettings().expect(200)).body.dashboardCalendarView).toBe("LANES");
  });

  it("rejects a view that is neither LANES nor STRIPES and keeps the stored one", async () => {
    await putSettings({ dashboardCalendarView: "STRIPES" }).expect(200);

    await putSettings({ dashboardCalendarView: "TIMELINE" }).expect(422);

    expect((await getSettings().expect(200)).body.dashboardCalendarView).toBe("STRIPES");
  });

  it("still saves the view after the stored group has lost its view access", async () => {
    await putSettings({ dashboardScope: "GROUP", dashboardGroupId: GROUP_ID }).expect(200);

    await db
      .update(groupUsers)
      .set({ viewAccess: false })
      .where(and(eq(groupUsers.userId, viewerId), eq(groupUsers.groupId, GROUP_ID)));

    const saved = await putSettings({ dashboardCalendarView: "LANES" }).expect(200);
    expect(saved.body).toMatchObject({
      dashboardCalendarView: "LANES",
      dashboardScope: "GROUP",
      dashboardGroupId: GROUP_ID,
    });

    await putSettings({ dashboardScope: "GROUP" }).expect(403);
  });
});

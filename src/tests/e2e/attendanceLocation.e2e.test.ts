import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import type { Express } from "express";
import { and, asc, eq } from "drizzle-orm";
import { createServer } from "../../server.js";
import { db } from "../../db/db.js";
import { groups } from "../../db/schema/group-schema.js";
import { groupUsers } from "../../db/schema/group-users-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import {
  attendanceClosedBy,
  attendanceEvents,
  attendanceSessions,
} from "../../db/schema/attendance-schema.js";
import {
  ATTENDANCE_SETTINGS_DEFAULTS,
  organizationAttendanceSettings,
  type balanceMode,
} from "../../db/schema/organization-attendance-settings-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { createTestUser, cleanupTestData } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { upsertAttendanceSettings } from "../../services/organization/attendanceSettingsServices.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import { sweepAttendanceLocations } from "../../services/attendance/attendanceRetention.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ZONE = "Europe/Prague";

/** A fix somewhere in Prague; only the accuracy ever matters to the rules. */
const PRAGUE = { latitude: 50.0755, longitude: 14.4378 };

let ORGANIZATION_ID: string;

const settings = (locationEnabled = true) =>
  upsertAttendanceSettings(ORGANIZATION_ID, {
    ...ATTENDANCE_SETTINGS_DEFAULTS,
    balanceMode: ATTENDANCE_SETTINGS_DEFAULTS.balanceMode as balanceMode,
    attendanceEnabled: true,
    timezone: ZONE,
    locationEnabled,
  });

describe("attendance location", () => {
  let app: Express;

  let owner: { id: string };
  let member: { id: string };
  let other: { id: string };

  let memberCookie: string;
  let otherCookie: string;
  let memberEmploymentId: string;

  const clockIn = () => request(app).post("/api/attendance/clock-in").set("Cookie", memberCookie);
  const clockOut = () => request(app).post("/api/attendance/clock-out").set("Cookie", memberCookie);

  const sendFix = (
    sessionId: string,
    fix: { end: "IN" | "OUT"; accuracy: number; latitude?: number; longitude?: number },
    cookie = memberCookie
  ) =>
    request(app)
      .post(`/api/attendance/sessions/${sessionId}/location`)
      .set("Cookie", cookie)
      .send({ ...PRAGUE, ...fix });

  const sessionRow = (id: string) =>
    db
      .select()
      .from(attendanceSessions)
      .where(eq(attendanceSessions.id, id))
      .then((rows) => rows[0]!);

  const locationEvents = (sessionId: string) =>
    db
      .select({ eventType: attendanceEvents.eventType, after: attendanceEvents.after })
      .from(attendanceEvents)
      .where(
        and(
          eq(attendanceEvents.sessionId, sessionId),
          eq(attendanceEvents.eventType, "LOCATION_UPDATED")
        )
      )
      .orderBy(asc(attendanceEvents.createdAt));

  /** Ages one end's instant so the two-minute window has closed on it. */
  const age = (sessionId: string, end: "IN" | "OUT", minutes: number) => {
    const moved = new Date(Date.now() - minutes * 60 * 1000);
    return db
      .update(attendanceSessions)
      .set(end === "IN" ? { startedAt: moved } : { endedAt: moved })
      .where(eq(attendanceSessions.id, sessionId));
  };

  beforeAll(async () => {
    await cleanupTestData();
    app = createServer();

    owner = await createTestUser("loc-owner@test.com", "Olivia Owner", "password123");
    member = await createTestUser("loc-member@test.com", "Milo Member", "password123");
    other = await createTestUser("loc-other@test.com", "Nina Other", "password123");

    ORGANIZATION_ID = (await ensureOrganizationForUser(owner.id)).id;

    const groupId = uuidv4();
    await db.insert(groups).values({
      id: groupId,
      organizationId: ORGANIZATION_ID,
      groupName: "Engineering",
      managerUserId: owner.id,
      mainApprovalUser: owner.id,
    });
    for (const userId of [member.id, other.id]) {
      await db.insert(groupUsers).values({
        id: uuidv4(),
        userId,
        groupId,
        viewAccess: true,
        adminAccess: false,
        approverAccess: false,
        controlledUser: true,
      });
      await syncEmployment(ORGANIZATION_ID, userId);
    }

    const [employment] = await db
      .select({ id: employments.id })
      .from(employments)
      .where(
        and(eq(employments.organizationId, ORGANIZATION_ID), eq(employments.userId, member.id))
      );
    memberEmploymentId = employment!.id;

    memberCookie = await authCookieFor(member.id);
    otherCookie = await authCookieFor(other.id);

    await upsertSubscription(ORGANIZATION_ID, {
      plan: subscriptionPlan.Pro,
      status: subscriptionStatus.Active,
      graceEndsAt: null,
    });
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  beforeEach(async () => {
    await db.delete(attendanceSessions);
    await settings();
  });

  describe("attaching a fix", () => {
    it("stores the first fix on the clock-in end and records one event", async () => {
      const session = await clockIn().expect(201);

      const applied = await sendFix(session.body.id, { end: "IN", accuracy: 120 }).expect(200);
      expect(applied.body).toMatchObject({ applied: true, end: "IN", accuracy: 120, ...PRAGUE });

      const row = await sessionRow(session.body.id);
      expect(row.startLatitude).toBeCloseTo(PRAGUE.latitude);
      expect(row.startLongitude).toBeCloseTo(PRAGUE.longitude);
      expect(row.startAccuracy).toBe(120);
      // The clock-out end is a separate pair of columns and stays untouched.
      expect(row.endLatitude).toBeNull();
      expect(row.endAccuracy).toBeNull();

      expect(await locationEvents(session.body.id)).toHaveLength(1);
    });

    it("lets a sharper fix replace a coarse one", async () => {
      const session = await clockIn().expect(201);

      await sendFix(session.body.id, { end: "IN", accuracy: 1200 }).expect(200);
      const sharper = await sendFix(session.body.id, {
        end: "IN",
        accuracy: 8,
        latitude: 50.09,
        longitude: 14.45,
      }).expect(200);

      expect(sharper.body).toMatchObject({ applied: true, accuracy: 8, latitude: 50.09 });

      const row = await sessionRow(session.body.id);
      expect(row.startAccuracy).toBe(8);
      expect(row.startLatitude).toBeCloseTo(50.09);

      expect(await locationEvents(session.body.id)).toHaveLength(2);
    });

    it("takes the clock-out fix on its own end once the session is closed", async () => {
      const session = await clockIn().expect(201);
      await sendFix(session.body.id, { end: "IN", accuracy: 30 }).expect(200);
      await clockOut().expect(200);

      const out = await sendFix(session.body.id, { end: "OUT", accuracy: 25 }).expect(200);
      expect(out.body).toMatchObject({ applied: true, end: "OUT", accuracy: 25 });

      const row = await sessionRow(session.body.id);
      expect(row.startAccuracy).toBe(30);
      expect(row.endAccuracy).toBe(25);
    });

    it("shows the coordinates on the state read", async () => {
      const session = await clockIn().expect(201);
      await sendFix(session.body.id, { end: "IN", accuracy: 15 }).expect(200);

      const state = await request(app)
        .get("/api/attendance/current")
        .set("Cookie", memberCookie)
        .expect(200);

      expect(state.body.sessions[0]).toMatchObject({
        startAccuracy: 15,
        endLatitude: null,
        endLongitude: null,
        endAccuracy: null,
      });
      expect(state.body.sessions[0].startLatitude).toBeCloseTo(PRAGUE.latitude);
    });
  });

  describe("what it refuses to write", () => {
    it("is a no-op for a fix no better than the one stored", async () => {
      const session = await clockIn().expect(201);
      await sendFix(session.body.id, { end: "IN", accuracy: 20 }).expect(200);

      const worse = await sendFix(session.body.id, {
        end: "IN",
        accuracy: 900,
        latitude: 10,
        longitude: 10,
      }).expect(200);

      expect(worse.body).toMatchObject({ applied: false, accuracy: 20 });
      expect(worse.body.latitude).toBeCloseTo(PRAGUE.latitude);

      const row = await sessionRow(session.body.id);
      expect(row.startAccuracy).toBe(20);
      expect(row.startLatitude).toBeCloseTo(PRAGUE.latitude);

      // Only the change that landed left a row behind.
      expect(await locationEvents(session.body.id)).toHaveLength(1);
    });

    it("is a no-op for a fix that arrives after the two-minute window", async () => {
      const session = await clockIn().expect(201);
      await age(session.body.id, "IN", 3);

      const late = await sendFix(session.body.id, { end: "IN", accuracy: 5 }).expect(200);
      expect(late.body).toMatchObject({ applied: false, latitude: null, accuracy: null });

      const row = await sessionRow(session.body.id);
      expect(row.startAccuracy).toBeNull();
      expect(await locationEvents(session.body.id)).toHaveLength(0);
    });

    it("is a no-op for the clock-out end while the session is still open", async () => {
      const session = await clockIn().expect(201);

      const early = await sendFix(session.body.id, { end: "OUT", accuracy: 5 }).expect(200);
      expect(early.body).toMatchObject({ applied: false, end: "OUT", accuracy: null });

      expect((await sessionRow(session.body.id)).endAccuracy).toBeNull();
    });

    it("is a no-op while the organization has location switched off", async () => {
      await settings(false);
      const session = await clockIn().expect(201);

      const refused = await sendFix(session.body.id, { end: "IN", accuracy: 5 }).expect(200);
      expect(refused.body).toMatchObject({ applied: false, accuracy: null });

      expect((await sessionRow(session.body.id)).startAccuracy).toBeNull();
      expect(await locationEvents(session.body.id)).toHaveLength(0);
    });
  });

  describe("who may write a fix", () => {
    it("refuses another user's session and leaves it alone", async () => {
      const session = await clockIn().expect(201);

      const refused = await sendFix(
        session.body.id,
        { end: "IN", accuracy: 5 },
        otherCookie
      ).expect(403);
      expect(refused.body.errors[0].context).toMatchObject({ reason: "NOT_YOUR_SESSION" });

      expect((await sessionRow(session.body.id)).startAccuracy).toBeNull();
      expect(await locationEvents(session.body.id)).toHaveLength(0);
    });

    it("404s for a session that does not exist", async () => {
      await sendFix(uuidv4(), { end: "IN", accuracy: 5 }).expect(404);
    });

    it("401s without a session cookie", async () => {
      const session = await clockIn().expect(201);

      await request(app)
        .post(`/api/attendance/sessions/${session.body.id}/location`)
        .send({ ...PRAGUE, end: "IN", accuracy: 5 })
        .expect(401);
    });

    it("422s on coordinates outside the world", async () => {
      const session = await clockIn().expect(201);

      await sendFix(session.body.id, { end: "IN", accuracy: 5, latitude: 200 }).expect(422);
      await sendFix(session.body.id, { end: "IN", accuracy: 0 }).expect(422);
      await request(app)
        .post(`/api/attendance/sessions/${session.body.id}/location`)
        .set("Cookie", memberCookie)
        .send({ ...PRAGUE, end: "SIDEWAYS", accuracy: 5 })
        .expect(422);
    });
  });

  describe("the retention sweep", () => {
    /** A closed session on a business date of its own, with both ends located. */
    const located = async (businessDate: string) => {
      const id = uuidv4();
      const startedAt = new Date(`${businessDate}T08:00:00Z`);
      await db.insert(attendanceSessions).values({
        id,
        employmentId: memberEmploymentId,
        businessDate,
        startedAt,
        endedAt: new Date(startedAt.getTime() + 8 * 60 * 60 * 1000),
        timezone: ZONE,
        closedBy: attendanceClosedBy.User,
        startLatitude: PRAGUE.latitude,
        startLongitude: PRAGUE.longitude,
        startAccuracy: 12,
        endLatitude: PRAGUE.latitude,
        endLongitude: PRAGUE.longitude,
        endAccuracy: 18,
      });
      return id;
    };

    const isoDay = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);

    it("erases coordinates past twelve months and leaves recent ones standing", async () => {
      const old = await located(isoDay(400 * DAY_MS));
      const recent = await located(isoDay(30 * DAY_MS));

      const before = await sessionRow(old);

      expect(await sweepAttendanceLocations()).toEqual({ sessions: 1 });

      const swept = await sessionRow(old);
      expect(swept).toMatchObject({
        startLatitude: null,
        startLongitude: null,
        startAccuracy: null,
        endLatitude: null,
        endLongitude: null,
        endAccuracy: null,
      });

      // The session itself is the record; only the coordinates were evidence.
      expect(swept.businessDate).toBe(before.businessDate);
      expect(swept.startedAt).toEqual(before.startedAt);
      expect(swept.endedAt).toEqual(before.endedAt);
      expect(swept.timezone).toBe(before.timezone);
      expect(swept.closedBy).toBe(before.closedBy);
      expect(swept.employmentId).toBe(before.employmentId);
      expect(swept.createdAt).toEqual(before.createdAt);
      expect(swept.deletedAt).toBeNull();

      const kept = await sessionRow(recent);
      expect(kept.startAccuracy).toBe(12);
      expect(kept.endAccuracy).toBe(18);
    });

    it("leaves a session dated exactly twelve months back alone", async () => {
      const boundary = new Date();
      boundary.setUTCMonth(boundary.getUTCMonth() - 12);
      const id = await located(boundary.toISOString().slice(0, 10));

      expect(await sweepAttendanceLocations()).toEqual({ sessions: 0 });
      expect((await sessionRow(id)).startAccuracy).toBe(12);
    });

    it("reports nothing on a second pass", async () => {
      await located(isoDay(400 * DAY_MS));

      expect(await sweepAttendanceLocations()).toEqual({ sessions: 1 });
      expect(await sweepAttendanceLocations()).toEqual({ sessions: 0 });
    });

    it("sweeps a soft-deleted session too", async () => {
      const id = await located(isoDay(400 * DAY_MS));
      await db
        .update(attendanceSessions)
        .set({ deletedAt: new Date() })
        .where(eq(attendanceSessions.id, id));

      expect(await sweepAttendanceLocations()).toEqual({ sessions: 1 });
      expect((await sessionRow(id)).startAccuracy).toBeNull();
    });
  });

  describe("the one-time notice", () => {
    const getSettings = () =>
      request(app).get("/api/users/me/settings").set("Cookie", memberCookie);

    it("starts undismissed and stays dismissed once set", async () => {
      const initial = await getSettings().expect(200);
      expect(initial.body.attendanceLocationNoticeDismissed).toBe(false);

      const saved = await request(app)
        .put("/api/users/me/settings")
        .set("Cookie", memberCookie)
        .send({ attendanceLocationNoticeDismissed: true })
        .expect(200);
      expect(saved.body.attendanceLocationNoticeDismissed).toBe(true);

      const after = await getSettings().expect(200);
      expect(after.body.attendanceLocationNoticeDismissed).toBe(true);

      // Saving an unrelated card must not bring the notice back.
      await request(app)
        .put("/api/users/me/settings")
        .set("Cookie", memberCookie)
        .send({ emailNotifications: false })
        .expect(200);

      expect((await getSettings().expect(200)).body.attendanceLocationNoticeDismissed).toBe(true);
    });
  });

  describe("the organization switch", () => {
    it("tells the widget whether to ask the browser at all", async () => {
      await settings(false);
      const off = await request(app)
        .get("/api/attendance/current")
        .set("Cookie", memberCookie)
        .expect(200);
      expect(off.body.locationEnabled).toBe(false);

      await settings(true);
      const on = await request(app)
        .get("/api/attendance/current")
        .set("Cookie", memberCookie)
        .expect(200);
      expect(on.body.locationEnabled).toBe(true);
    });

    it("leaves the switch off for an organization that never set attendance up", async () => {
      await db.delete(organizationAttendanceSettings);

      const state = await request(app)
        .get("/api/attendance/current")
        .set("Cookie", memberCookie)
        .expect(200);
      expect(state.body.locationEnabled).toBe(false);
    });
  });
});

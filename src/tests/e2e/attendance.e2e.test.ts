import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
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
  attendanceBreaks,
  attendanceEvents,
  attendanceSessions,
} from "../../db/schema/attendance-schema.js";
import {
  ATTENDANCE_SETTINGS_DEFAULTS,
  organizationAttendanceSettings,
} from "../../db/schema/organization-attendance-settings-schema.js";
import { subscriptionPlan, subscriptionStatus } from "../../db/schema/subscription-schema.js";
import { createTestUser, cleanupTestData } from "./helpers/testSetup.js";
import { authCookieFor } from "./helpers/authHelper.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { upsertAttendanceSettings } from "../../services/organization/attendanceSettingsServices.js";
import { upsertSubscription } from "../../services/billing/subscriptionServices.js";
import type { balanceMode } from "../../db/schema/organization-attendance-settings-schema.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Europe/Prague is UTC+2 on this date, which is what the midnight cases turn on. */
const ZONE = "Europe/Prague";

let ORGANIZATION_ID: string;

const settings = (overrides: { attendanceEnabled?: boolean; locationEnabled?: boolean } = {}) =>
  upsertAttendanceSettings(ORGANIZATION_ID, {
    ...ATTENDANCE_SETTINGS_DEFAULTS,
    balanceMode: ATTENDANCE_SETTINGS_DEFAULTS.balanceMode as balanceMode,
    attendanceEnabled: true,
    timezone: ZONE,
    ...overrides,
  });

const proActive = () =>
  upsertSubscription(ORGANIZATION_ID, {
    plan: subscriptionPlan.Pro,
    status: subscriptionStatus.Active,
    graceEndsAt: null,
  });

const lapsed = () =>
  upsertSubscription(ORGANIZATION_ID, {
    plan: subscriptionPlan.Pro,
    status: subscriptionStatus.Canceled,
    graceEndsAt: new Date(Date.now() - DAY_MS),
  });

describe("attendance clock", () => {
  let app: Express;

  let owner: { id: string };
  let member: { id: string };
  /** Belongs to no organization at all. */
  let outsider: { id: string };

  let memberCookie: string;
  let outsiderCookie: string;
  let memberEmploymentId: string;

  const clockIn = () => request(app).post("/api/attendance/clock-in").set("Cookie", memberCookie);
  const clockOut = () => request(app).post("/api/attendance/clock-out").set("Cookie", memberCookie);
  const breakStart = () =>
    request(app).post("/api/attendance/break/start").set("Cookie", memberCookie);
  const breakEnd = () => request(app).post("/api/attendance/break/end").set("Cookie", memberCookie);
  const current = () => request(app).get("/api/attendance/current").set("Cookie", memberCookie);

  const eventsForMember = () =>
    db
      .select({
        id: attendanceEvents.id,
        sessionId: attendanceEvents.sessionId,
        eventType: attendanceEvents.eventType,
        changedByUserId: attendanceEvents.changedByUserId,
        after: attendanceEvents.after,
      })
      .from(attendanceEvents)
      .innerJoin(attendanceSessions, eq(attendanceEvents.sessionId, attendanceSessions.id))
      .where(eq(attendanceSessions.employmentId, memberEmploymentId))
      .orderBy(asc(attendanceEvents.createdAt));

  beforeAll(async () => {
    await cleanupTestData();
    app = createServer();

    owner = await createTestUser("clock-owner@test.com", "Olivia Owner", "password123");
    member = await createTestUser("clock-member@test.com", "Milo Member", "password123");
    outsider = await createTestUser("clock-outsider@test.com", "Otto Outsider", "password123");

    ORGANIZATION_ID = (await ensureOrganizationForUser(owner.id)).id;

    const groupId = uuidv4();
    await db.insert(groups).values({
      id: groupId,
      organizationId: ORGANIZATION_ID,
      groupName: "Engineering",
      managerUserId: owner.id,
      mainApprovalUser: owner.id,
    });
    await db.insert(groupUsers).values({
      id: uuidv4(),
      userId: member.id,
      groupId,
      viewAccess: true,
      adminAccess: false,
      approverAccess: false,
      controlledUser: true,
    });
    await syncEmployment(ORGANIZATION_ID, member.id);

    const [employment] = await db
      .select({ id: employments.id })
      .from(employments)
      .where(
        and(eq(employments.organizationId, ORGANIZATION_ID), eq(employments.userId, member.id))
      );
    memberEmploymentId = employment!.id;

    memberCookie = await authCookieFor(member.id);
    outsiderCookie = await authCookieFor(outsider.id);
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  beforeEach(async () => {
    await db.delete(attendanceSessions);
    await db.update(employments).set({ endedAt: null });
    await settings();
    await proActive();
  });

  describe("the day an employee actually has", () => {
    it("clocks in, breaks, comes back and clocks out", async () => {
      const empty = await current().expect(200);
      expect(empty.body).toMatchObject({
        organizationId: ORGANIZATION_ID,
        employmentId: memberEmploymentId,
        employmentEnded: false,
        active: true,
        locationEnabled: false,
        timezone: ZONE,
        openSession: null,
        openBreak: null,
        sessions: [],
      });

      const clockedIn = await clockIn().expect(201);
      expect(clockedIn.body).toMatchObject({
        open: true,
        endedAt: null,
        closedBy: null,
        timezone: ZONE,
        breaks: [],
      });

      const working = await current().expect(200);
      expect(working.body.openSession.id).toBe(clockedIn.body.id);
      expect(working.body.openBreak).toBeNull();
      expect(working.body.sessions).toHaveLength(1);

      const started = await breakStart().expect(201);
      expect(started.body).toMatchObject({
        sessionId: clockedIn.body.id,
        open: true,
        endedAt: null,
        autoClosed: false,
      });

      const onBreak = await current().expect(200);
      expect(onBreak.body.openBreak.id).toBe(started.body.id);

      const ended = await breakEnd().expect(200);
      expect(ended.body).toMatchObject({ id: started.body.id, open: false, autoClosed: false });
      expect(ended.body.endedAt).not.toBeNull();

      const clockedOut = await clockOut().expect(200);
      expect(clockedOut.body).toMatchObject({
        id: clockedIn.body.id,
        open: false,
        closedBy: "USER",
      });
      expect(clockedOut.body.endedAt).not.toBeNull();
      expect(clockedOut.body.breaks).toHaveLength(1);

      const done = await current().expect(200);
      expect(done.body.openSession).toBeNull();
      expect(done.body.openBreak).toBeNull();
      expect(done.body.sessions).toHaveLength(1);
      expect(done.body.sessions[0].breaks).toHaveLength(1);
    });

    it("leaves exactly one event per write, each stamped with the acting user", async () => {
      await clockIn().expect(201);
      expect(await eventsForMember()).toHaveLength(1);

      await breakStart().expect(201);
      expect(await eventsForMember()).toHaveLength(2);

      await breakEnd().expect(200);
      expect(await eventsForMember()).toHaveLength(3);

      await clockOut().expect(200);

      const events = await eventsForMember();
      expect(events).toHaveLength(4);
      expect(events.map((event) => event.eventType)).toEqual([
        "CLOCK_IN",
        "BREAK_START",
        "BREAK_END",
        "CLOCK_OUT",
      ]);
      expect(events.every((event) => event.changedByUserId === member.id)).toBe(true);
    });

    it("records a second session on the same business date", async () => {
      await clockIn().expect(201);
      await clockOut().expect(200);
      await clockIn().expect(201);

      const state = await current().expect(200);
      expect(state.body.sessions).toHaveLength(2);
      expect(state.body.openSession.id).toBe(state.body.sessions[1].id);
    });
  });

  describe("clocking out with a break still running", () => {
    it("closes the break at the same instant and writes one event, not two", async () => {
      const session = await clockIn().expect(201);
      const started = await breakStart().expect(201);

      const clockedOut = await clockOut().expect(200);

      expect(clockedOut.body.breaks).toHaveLength(1);
      // Not flagged auto-closed: that marker is the ceiling sweep's, and the
      // correction dashboard reads it.
      expect(clockedOut.body.breaks[0]).toMatchObject({
        id: started.body.id,
        autoClosed: false,
        open: false,
      });
      expect(clockedOut.body.breaks[0].endedAt).toBe(clockedOut.body.endedAt);

      // Clock-in, break-start, clock-out: the auto-closed break rides on the
      // clock-out's own row rather than adding a fourth.
      const events = await eventsForMember();
      expect(events).toHaveLength(3);
      expect(events[2]).toMatchObject({ eventType: "CLOCK_OUT", sessionId: session.body.id });
      expect(events[2]!.after).toMatchObject({ closedOpenBreakId: started.body.id });
    });
  });

  describe("conflicts", () => {
    it("refuses a second clock-in and says when the open one started", async () => {
      const open = await clockIn().expect(201);

      const conflict = await clockIn().expect(409);
      expect(conflict.body.errors[0].context).toMatchObject({
        reason: "SESSION_ALREADY_OPEN",
        sessionId: open.body.id,
        startedAt: open.body.startedAt,
      });
    });

    it("refuses a clock-out with nothing open", async () => {
      const conflict = await clockOut().expect(409);
      expect(conflict.body.errors[0].context).toMatchObject({ reason: "NO_OPEN_SESSION" });
    });

    it("refuses a break with nothing open", async () => {
      const conflict = await breakStart().expect(409);
      expect(conflict.body.errors[0].context).toMatchObject({ reason: "NO_OPEN_SESSION" });
    });

    it("refuses a second break inside one session", async () => {
      await clockIn().expect(201);
      const started = await breakStart().expect(201);

      const conflict = await breakStart().expect(409);
      expect(conflict.body.errors[0].context).toMatchObject({
        reason: "BREAK_ALREADY_OPEN",
        breakId: started.body.id,
        startedAt: started.body.startedAt,
      });
    });

    it("refuses ending a break that is not running", async () => {
      await clockIn().expect(201);

      const conflict = await breakEnd().expect(409);
      expect(conflict.body.errors[0].context).toMatchObject({ reason: "NO_OPEN_BREAK" });
    });

    it("refuses ending a break with nothing clocked in at all", async () => {
      const conflict = await breakEnd().expect(409);
      expect(conflict.body.errors[0].context).toMatchObject({ reason: "NO_OPEN_SESSION" });
    });

    it("lets exactly one of two concurrent clock-ins through", async () => {
      const [first, second] = await Promise.all([clockIn(), clockIn()]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 409]);

      const rows = await db
        .select({ id: attendanceSessions.id })
        .from(attendanceSessions)
        .where(eq(attendanceSessions.employmentId, memberEmploymentId));
      expect(rows).toHaveLength(1);

      // The loser rolled back whole: no orphan event for a session that is not there.
      expect(await eventsForMember()).toHaveLength(1);
    });
  });

  describe("who may write", () => {
    it("refuses an ended Employment and leaves the history readable", async () => {
      await clockIn().expect(201);
      await clockOut().expect(200);

      await db
        .update(employments)
        .set({ endedAt: new Date() })
        .where(eq(employments.id, memberEmploymentId));

      const refused = await clockIn().expect(403);
      expect(refused.body.errors[0].context).toMatchObject({ reason: "EMPLOYMENT_ENDED" });

      const state = await current().expect(200);
      expect(state.body.employmentEnded).toBe(true);
      expect(state.body.sessions).toHaveLength(1);
    });

    it("404s for someone who holds no Employment anywhere", async () => {
      await request(app).get("/api/attendance/current").set("Cookie", outsiderCookie).expect(404);

      await request(app).post("/api/attendance/clock-in").set("Cookie", outsiderCookie).expect(404);
    });

    it("401s without a session", async () => {
      await request(app).get("/api/attendance/current").expect(401);
    });
  });

  describe("the plan gate", () => {
    it("refuses every write with 402 once the plan has lapsed", async () => {
      await lapsed();

      for (const send of [clockIn, clockOut, breakStart, breakEnd]) {
        const refused = await send().expect(402);
        expect(refused.body.errors[0].context).toMatchObject({ reason: "PLAN_LIMIT" });
      }
    });

    it("refuses every write with 402 while attendance is switched off", async () => {
      await settings({ attendanceEnabled: false });

      await clockIn().expect(402);
      await breakStart().expect(402);
    });

    it("keeps the day readable with active false rather than refusing the read", async () => {
      await clockIn().expect(201);
      await clockOut().expect(200);

      await lapsed();

      const state = await current().expect(200);
      expect(state.body.active).toBe(false);
      expect(state.body.sessions).toHaveLength(1);
    });

    it("answers active false for an organization that never set attendance up", async () => {
      await db.delete(organizationAttendanceSettings);

      const state = await current().expect(200);
      expect(state.body).toMatchObject({
        active: false,
        timezone: null,
        businessDate: null,
        openSession: null,
        sessions: [],
      });
    });
  });

  describe("the business date is the organization's local day", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Only `Date` is faked: the pg driver's own timers have to keep running. */
    const at = (instant: string) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(instant));
    };

    it("puts a 23:30 local clock-in on that local date, not the UTC one", async () => {
      at("2026-07-15T21:30:00Z");

      const session = await clockIn().expect(201);

      expect(session.body.businessDate).toBe("2026-07-15");
      expect(session.body.timezone).toBe(ZONE);
    });

    it("puts a 00:30 local clock-in on the next date, while UTC is still on the day before", async () => {
      at("2026-07-15T22:30:00Z");

      const session = await clockIn().expect(201);

      expect(session.body.businessDate).toBe("2026-07-16");
    });

    it("leaves a session that crosses midnight on the day it started", async () => {
      at("2026-07-15T21:30:00Z");
      const session = await clockIn().expect(201);

      at("2026-07-15T23:30:00Z");
      const closed = await clockOut().expect(200);

      expect(closed.body.businessDate).toBe("2026-07-15");

      // Still the open session's day, so the state read of the *next* day has
      // the session on the button without it counting to that day's total.
      const state = await current().expect(200);
      expect(state.body.businessDate).toBe("2026-07-16");
      expect(state.body.sessions).toHaveLength(0);
      expect(state.body.openSession).toBeNull();
      expect(session.body.businessDate).toBe("2026-07-15");
    });

    it("keeps an open session on the button after midnight", async () => {
      at("2026-07-15T21:30:00Z");
      const session = await clockIn().expect(201);

      at("2026-07-15T23:30:00Z");
      const state = await current().expect(200);

      expect(state.body.businessDate).toBe("2026-07-16");
      expect(state.body.sessions).toHaveLength(0);
      expect(state.body.openSession.id).toBe(session.body.id);
      expect(state.body.openSession.businessDate).toBe("2026-07-15");
    });
  });

  describe("scoping", () => {
    it("accepts the organization named explicitly", async () => {
      const state = await request(app)
        .get(`/api/attendance/current?organizationId=${ORGANIZATION_ID}`)
        .set("Cookie", memberCookie)
        .expect(200);

      expect(state.body.organizationId).toBe(ORGANIZATION_ID);
    });

    it("404s for an organization the caller is not employed by", async () => {
      await request(app)
        .get(`/api/attendance/current?organizationId=${uuidv4()}`)
        .set("Cookie", memberCookie)
        .expect(404);
    });

    it("422s on a malformed organizationId", async () => {
      await request(app)
        .post("/api/attendance/clock-in")
        .set("Cookie", memberCookie)
        .send({ organizationId: "" })
        .expect(422);
    });
  });

  describe("the breaks table", () => {
    it("holds one open break per session in the database, not only in the handler", async () => {
      const session = await clockIn().expect(201);
      await breakStart().expect(201);

      await expect(
        db.insert(attendanceBreaks).values({
          id: uuidv4(),
          sessionId: session.body.id,
          startedAt: new Date(),
        })
      ).rejects.toThrow();
    });

    it("holds one open session per Employment in the database", async () => {
      await clockIn().expect(201);

      await expect(
        db.insert(attendanceSessions).values({
          id: uuidv4(),
          employmentId: memberEmploymentId,
          businessDate: "2026-07-15",
          startedAt: new Date(),
          timezone: ZONE,
        })
      ).rejects.toThrow();
    });
  });
});

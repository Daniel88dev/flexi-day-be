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
  attendanceBreaks,
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
import { businessDateInZone } from "../../utils/dateFunc.js";
import { sweepAttendanceCeilings } from "../../services/attendance/attendanceCeilings.js";

const MINUTE_MS = 60 * 1000;
const ZONE = "Europe/Prague";

/** Short ceilings, so a test ages a clock by minutes rather than by sixteen hours. */
const SESSION_CEILING = 600;
const BREAK_CEILING = 90;

let ORGANIZATION_ID: string;

const settings = (
  overrides: { sessionCeilingMinutes?: number; breakCeilingMinutes?: number } = {}
) =>
  upsertAttendanceSettings(ORGANIZATION_ID, {
    ...ATTENDANCE_SETTINGS_DEFAULTS,
    balanceMode: ATTENDANCE_SETTINGS_DEFAULTS.balanceMode as balanceMode,
    attendanceEnabled: true,
    timezone: ZONE,
    sessionCeilingMinutes: SESSION_CEILING,
    breakCeilingMinutes: BREAK_CEILING,
    ...overrides,
  });

describe("attendance ceilings", () => {
  let app: Express;

  let owner: { id: string };
  let member: { id: string };

  let memberCookie: string;
  let memberEmploymentId: string;

  const clockIn = () => request(app).post("/api/attendance/clock-in").set("Cookie", memberCookie);
  const current = () => request(app).get("/api/attendance/current").set("Cookie", memberCookie);

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * MINUTE_MS);

  /**
   * An open session that started `minutes` ago, as if the person never clocked
   * out. The business date follows the instant, except where a test needs the
   * session on today's date so the widget's day list picks it up.
   */
  const openSession = async (minutes: number, businessDate?: string) => {
    const id = uuidv4();
    const startedAt = minutesAgo(minutes);
    await db.insert(attendanceSessions).values({
      id,
      employmentId: memberEmploymentId,
      businessDate: businessDate ?? businessDateInZone(startedAt, ZONE),
      startedAt,
      timezone: ZONE,
    });
    return { id, startedAt };
  };

  /** An open break inside a session, started `minutes` ago. */
  const openBreak = async (sessionId: string, minutes: number) => {
    const id = uuidv4();
    const startedAt = minutesAgo(minutes);
    await db.insert(attendanceBreaks).values({ id, sessionId, startedAt });
    return { id, startedAt };
  };

  const sessionRow = (id: string) =>
    db
      .select()
      .from(attendanceSessions)
      .where(eq(attendanceSessions.id, id))
      .then((rows) => rows[0]!);

  const breakRow = (id: string) =>
    db
      .select()
      .from(attendanceBreaks)
      .where(eq(attendanceBreaks.id, id))
      .then((rows) => rows[0]!);

  const eventsFor = (sessionId: string) =>
    db
      .select({
        eventType: attendanceEvents.eventType,
        changedByUserId: attendanceEvents.changedByUserId,
        before: attendanceEvents.before,
        after: attendanceEvents.after,
      })
      .from(attendanceEvents)
      .where(eq(attendanceEvents.sessionId, sessionId))
      .orderBy(asc(attendanceEvents.createdAt));

  beforeAll(async () => {
    await cleanupTestData();
    app = createServer();

    owner = await createTestUser("ceiling-owner@test.com", "Olivia Owner", "password123");
    member = await createTestUser("ceiling-member@test.com", "Milo Member", "password123");

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
    await db.update(employments).set({ endedAt: null });
    await settings();
  });

  describe("the session a person forgot to close", () => {
    it("closes it at started-at plus the ceiling, not at the instant the sweep ran", async () => {
      const overdue = await openSession(SESSION_CEILING + 120);

      expect(await sweepAttendanceCeilings()).toMatchObject({ sessions: 1, breaks: 0 });

      const closed = await sessionRow(overdue.id);
      expect(closed.closedBy).toBe(attendanceClosedBy.Sweep);
      expect(closed.endedAt?.getTime()).toBe(
        overdue.startedAt.getTime() + SESSION_CEILING * MINUTE_MS
      );
      // Two hours short of now: the sweep closes the clock where the ceiling
      // is, not where the tick happened to land.
      expect(closed.endedAt!.getTime()).toBeLessThan(Date.now() - 60 * MINUTE_MS);
    });

    it("leaves one still under the ceiling open", async () => {
      const running = await openSession(SESSION_CEILING - 30);

      expect(await sweepAttendanceCeilings()).toMatchObject({ sessions: 0, breaks: 0 });

      const untouched = await sessionRow(running.id);
      expect(untouched.endedAt).toBeNull();
      expect(untouched.closedBy).toBeNull();
    });

    it("writes one clock-out event with no changing user", async () => {
      const overdue = await openSession(SESSION_CEILING + 1);

      await sweepAttendanceCeilings();

      const events = await eventsFor(overdue.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        eventType: "CLOCK_OUT",
        changedByUserId: null,
        before: { endedAt: null, closedBy: null },
      });
      expect(events[0]!.after).toMatchObject({
        closedBy: attendanceClosedBy.Sweep,
        closedOpenBreakId: null,
      });
    });

    it("does not block the next clock-in", async () => {
      await openSession(SESSION_CEILING + 60);
      await sweepAttendanceCeilings();

      const fresh = await clockIn().expect(201);
      expect(fresh.body).toMatchObject({ open: true, endedAt: null, closedBy: null });

      const state = await current().expect(200);
      expect(state.body.openSession.id).toBe(fresh.body.id);
    });

    it("closes one left open by an organization whose plan has lapsed", async () => {
      const overdue = await openSession(SESSION_CEILING + 10);
      await upsertSubscription(ORGANIZATION_ID, {
        plan: subscriptionPlan.Pro,
        status: subscriptionStatus.Canceled,
        graceEndsAt: minutesAgo(60 * 24),
      });

      try {
        expect(await sweepAttendanceCeilings()).toMatchObject({ sessions: 1 });
        expect((await sessionRow(overdue.id)).closedBy).toBe(attendanceClosedBy.Sweep);
      } finally {
        await upsertSubscription(ORGANIZATION_ID, {
          plan: subscriptionPlan.Pro,
          status: subscriptionStatus.Active,
          graceEndsAt: null,
        });
      }
    });

    it("closes one left open by an employment that has since ended", async () => {
      const overdue = await openSession(SESSION_CEILING + 10);
      await db.update(employments).set({ endedAt: new Date() });

      expect(await sweepAttendanceCeilings()).toMatchObject({ sessions: 1 });
      expect((await sessionRow(overdue.id)).closedBy).toBe(attendanceClosedBy.Sweep);
    });

    it("leaves a soft-deleted session alone", async () => {
      const overdue = await openSession(SESSION_CEILING + 60);
      await db
        .update(attendanceSessions)
        .set({ deletedAt: new Date() })
        .where(eq(attendanceSessions.id, overdue.id));

      expect(await sweepAttendanceCeilings()).toMatchObject({ sessions: 0, breaks: 0 });
      expect((await sessionRow(overdue.id)).endedAt).toBeNull();
    });

    it("falls back to the default ceiling for an organization with no settings row", async () => {
      await db.delete(organizationAttendanceSettings);
      // Past the ceiling this organization had configured, still under the
      // default it now falls back to — the premise the first half rests on.
      const underDefault = SESSION_CEILING + 60;
      expect(underDefault).toBeLessThan(ATTENDANCE_SETTINGS_DEFAULTS.sessionCeilingMinutes);
      // One open session per Employment, so the same one is aged rather than a
      // second one opened beside it.
      const session = await openSession(underDefault);

      expect(await sweepAttendanceCeilings()).toMatchObject({ sessions: 0 });
      expect((await sessionRow(session.id)).endedAt).toBeNull();

      const pastDefault = minutesAgo(ATTENDANCE_SETTINGS_DEFAULTS.sessionCeilingMinutes + 30);
      await db
        .update(attendanceSessions)
        .set({ startedAt: pastDefault })
        .where(eq(attendanceSessions.id, session.id));

      expect(await sweepAttendanceCeilings()).toMatchObject({ sessions: 1 });

      const closed = await sessionRow(session.id);
      expect(closed.closedBy).toBe(attendanceClosedBy.Sweep);
      expect(closed.endedAt?.getTime()).toBe(
        pastDefault.getTime() + ATTENDANCE_SETTINGS_DEFAULTS.sessionCeilingMinutes * MINUTE_MS
      );
    });
  });

  describe("the break a person forgot to end", () => {
    it("closes it at its own ceiling and leaves the session running", async () => {
      const session = await openSession(BREAK_CEILING + 60);
      const entry = await openBreak(session.id, BREAK_CEILING + 30);

      expect(await sweepAttendanceCeilings()).toMatchObject({ sessions: 0, breaks: 1 });

      const closed = await breakRow(entry.id);
      expect(closed.autoClosed).toBe(true);
      expect(closed.endedAt?.getTime()).toBe(entry.startedAt.getTime() + BREAK_CEILING * MINUTE_MS);

      expect((await sessionRow(session.id)).endedAt).toBeNull();
    });

    it("leaves one still under its ceiling open", async () => {
      const session = await openSession(BREAK_CEILING);
      const entry = await openBreak(session.id, BREAK_CEILING - 5);

      expect(await sweepAttendanceCeilings()).toMatchObject({ sessions: 0, breaks: 0 });

      const untouched = await breakRow(entry.id);
      expect(untouched.endedAt).toBeNull();
      expect(untouched.autoClosed).toBe(false);
    });

    it("writes one break-end event with no changing user", async () => {
      const session = await openSession(BREAK_CEILING + 10);
      const entry = await openBreak(session.id, BREAK_CEILING + 5);

      await sweepAttendanceCeilings();

      const events = await eventsFor(session.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        eventType: "BREAK_END",
        changedByUserId: null,
        before: { breakId: entry.id, endedAt: null, autoClosed: false },
      });
      expect(events[0]!.after).toMatchObject({ breakId: entry.id, autoClosed: true });
    });

    it("leaves one open under a session somebody already closed", async () => {
      const session = await openSession(BREAK_CEILING + 60);
      const entry = await openBreak(session.id, BREAK_CEILING + 30);
      await db
        .update(attendanceSessions)
        .set({ endedAt: minutesAgo(1), closedBy: attendanceClosedBy.User })
        .where(eq(attendanceSessions.id, session.id));

      // Nobody is on this break, and stamping it auto-closed at an instant its
      // own ceiling never reached would invent a correction for the employee.
      expect(await sweepAttendanceCeilings()).toMatchObject({ sessions: 0, breaks: 0 });
      expect((await breakRow(entry.id)).endedAt).toBeNull();
    });

    it("never closes a break after the session holding it", async () => {
      // Past its own ceiling, but started so late in the session that the
      // ceiling falls beyond the session's own: the clamp is the only thing
      // keeping the two in order.
      const session = await openSession(SESSION_CEILING + 100);
      const entry = await openBreak(session.id, BREAK_CEILING + 60);
      expect(entry.startedAt.getTime()).toBeGreaterThan(
        session.startedAt.getTime() + (SESSION_CEILING - BREAK_CEILING) * MINUTE_MS
      );

      expect(await sweepAttendanceCeilings()).toMatchObject({ sessions: 1, breaks: 1 });

      const closedSession = await sessionRow(session.id);
      const closedBreak = await breakRow(entry.id);
      expect(closedBreak.endedAt?.getTime()).toBe(closedSession.endedAt?.getTime());
      expect(closedBreak.autoClosed).toBe(true);
    });

    it("never ends a break before it started, even one begun past the session's ceiling", async () => {
      // Nothing stops a person taking a break on a session that has already run
      // past its ceiling: the sweep closes it on the next tick, not the instant
      // the ceiling passed, and a break may start in the window between.
      const session = await openSession(SESSION_CEILING + 120);
      const entry = await openBreak(session.id, 60);
      expect(entry.startedAt.getTime()).toBeGreaterThan(
        session.startedAt.getTime() + SESSION_CEILING * MINUTE_MS
      );

      expect(await sweepAttendanceCeilings()).toMatchObject({ sessions: 1, breaks: 0 });

      const closedSession = await sessionRow(session.id);
      const closedBreak = await breakRow(entry.id);
      // The session still closes where the ceiling is, per the spec, so the
      // break collapses to nothing rather than ending before it began.
      expect(closedSession.endedAt?.getTime()).toBe(
        session.startedAt.getTime() + SESSION_CEILING * MINUTE_MS
      );
      expect(closedBreak.endedAt?.getTime()).toBe(entry.startedAt.getTime());
      expect(closedBreak.endedAt!.getTime()).toBeGreaterThanOrEqual(
        closedBreak.startedAt.getTime()
      );
      expect(closedBreak.autoClosed).toBe(false);
    });

    it("counts a break inside its ceiling to the session's own close", async () => {
      const session = await openSession(SESSION_CEILING + 10);
      const entry = await openBreak(session.id, BREAK_CEILING - 10);

      expect(await sweepAttendanceCeilings()).toMatchObject({ sessions: 1, breaks: 0 });

      const closedSession = await sessionRow(session.id);
      const closedBreak = await breakRow(entry.id);
      expect(closedBreak.endedAt?.getTime()).toBe(closedSession.endedAt?.getTime());
      // Not the employee's to correct: the break never ran past its ceiling,
      // it was simply still running when the session ended.
      expect(closedBreak.autoClosed).toBe(false);

      const events = await eventsFor(session.id);
      expect(events).toHaveLength(1);
      expect(events[0]!.after).toMatchObject({ closedOpenBreakId: entry.id });
    });
  });

  describe("what the widget reads afterwards", () => {
    it("carries the closed-by and auto-closed markers, with nothing left open", async () => {
      const today = businessDateInZone(new Date(), ZONE);
      const overdue = await openSession(SESSION_CEILING + 60, today);
      const entry = await openBreak(overdue.id, BREAK_CEILING + 30);

      await sweepAttendanceCeilings();

      const state = await current().expect(200);
      expect(state.body.openSession).toBeNull();
      expect(state.body.openBreak).toBeNull();

      const day = state.body.sessions.find((row: { id: string }) => row.id === overdue.id);
      expect(day).toMatchObject({
        open: false,
        closedBy: attendanceClosedBy.Sweep,
        breaks: [{ id: entry.id, autoClosed: true, open: false }],
      });

      expect(state.body.autoClosedSession).toMatchObject({
        id: overdue.id,
        closedBy: attendanceClosedBy.Sweep,
      });
    });

    it("still asks about a day the sweep closed after midnight", async () => {
      const yesterday = businessDateInZone(new Date(Date.now() - 24 * 60 * MINUTE_MS), ZONE);
      const overdue = await openSession(SESSION_CEILING + 60, yesterday);

      await sweepAttendanceCeilings();

      const state = await current().expect(200);
      // Not in today's list, and still the thing to correct.
      expect(state.body.sessions).toEqual([]);
      expect(state.body.autoClosedSession).toMatchObject({
        id: overdue.id,
        businessDate: yesterday,
        closedBy: attendanceClosedBy.Sweep,
      });
    });

    it("asks about an ordinary day holding an auto-closed break", async () => {
      const today = businessDateInZone(new Date(), ZONE);
      const session = await openSession(BREAK_CEILING + 60, today);
      const entry = await openBreak(session.id, BREAK_CEILING + 30);

      await sweepAttendanceCeilings();

      const state = await current().expect(200);
      // The session is still running and was nobody's mistake; the break inside
      // it is the wrong number.
      expect(state.body.openSession.id).toBe(session.id);
      expect(state.body.autoClosedSession).toMatchObject({
        id: session.id,
        closedBy: null,
        breaks: [{ id: entry.id, autoClosed: true }],
      });
    });

    it("asks about nothing when no clock was swept", async () => {
      await openSession(SESSION_CEILING - 30);

      await sweepAttendanceCeilings();

      expect((await current().expect(200)).body.autoClosedSession).toBeNull();
    });
  });

  describe("running it twice", () => {
    it("reports nothing on the second pass", async () => {
      const session = await openSession(SESSION_CEILING + 60);
      await openBreak(session.id, BREAK_CEILING + 30);

      expect(await sweepAttendanceCeilings()).toMatchObject({ sessions: 1, breaks: 1 });
      expect(await sweepAttendanceCeilings()).toMatchObject({ sessions: 0, breaks: 0 });
    });

    it("reports nothing at all when every clock is closed", async () => {
      expect(await sweepAttendanceCeilings()).toMatchObject({ sessions: 0, breaks: 0 });
    });
  });
});

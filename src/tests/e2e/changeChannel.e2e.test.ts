import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/db.js";
import { attendanceSessions } from "../../db/schema/attendance-schema.js";
import type { ChangeChannel } from "../../db/schema/change-channel-schema.js";
import { employments } from "../../db/schema/employment-schema.js";
import {
  ATTENDANCE_SETTINGS_DEFAULTS,
  type balanceMode,
} from "../../db/schema/organization-attendance-settings-schema.js";
import type { AuthSession } from "../../middleware/authSession.js";
import { createServer } from "../../server.js";
import { clockInOwn, clockOutOwn } from "../../services/attendance/ownAttendance.js";
import { showProfileSection } from "../../services/directory/directoryLookups.js";
import { syncEmployment } from "../../services/employment/employmentServices.js";
import { upsertAttendanceSettings } from "../../services/organization/attendanceSettingsServices.js";
import { ensureOrganizationForUser } from "../../services/organization/organizationServices.js";
import { createRequest } from "../../services/vacation/requestCreation.js";
import { validatePostVacation } from "../../services/vacation/types.js";
import { approveRequest, cancelRequest } from "../../services/vacation/vacationTransitions.js";
import { listenOnLoopback, type LoopbackServer } from "../loopbackServer.js";
import { apiAs, enableEnterpriseDirectory } from "./helpers/directoryWorld.js";
import {
  addMember,
  addQuota,
  makeGroup,
  makeUser,
  resetReportData,
} from "./helpers/reportFixtures.js";
import { cleanupTestData } from "./helpers/testSetup.js";

const YEAR = new Date().getUTCFullYear() + 1;

const firstWednesdayOfMarch = (year: number): string => {
  const day = new Date(Date.UTC(year, 2, 1));
  while (day.getUTCDay() !== 3) day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
};

const WED = firstWednesdayOfMarch(YEAR);

const through = (
  person: { id: string; name: string; email: string },
  channel: ChangeChannel
): AuthSession => ({
  sessionId: `change-channel-${channel}`,
  userId: person.id,
  userName: person.name,
  userEmail: person.email,
  emailVerified: true,
  channel,
});

/** Olga owns the organization and manages Support; Mia is a member of it. */
const seed = async () => {
  const olga = await makeUser("Olga Owner");
  const mia = await makeUser("Mia Member");

  const organizationId = (await ensureOrganizationForUser(olga.id)).id;
  const support = await makeGroup("Support", olga.id, { organizationOwnerId: olga.id });
  await addMember(support, olga.id);
  await addMember(support, mia.id, { viewAccess: true });
  await addQuota(support, mia.id, YEAR, { vacationDays: 20 });
  for (const person of [olga, mia]) await syncEmployment(organizationId, person.id);

  const [miaEmployment] = await db
    .select({ id: employments.id })
    .from(employments)
    .where(and(eq(employments.userId, mia.id), eq(employments.organizationId, organizationId)));

  await enableEnterpriseDirectory(organizationId, olga.id);
  await upsertAttendanceSettings(organizationId, {
    ...ATTENDANCE_SETTINGS_DEFAULTS,
    balanceMode: ATTENDANCE_SETTINGS_DEFAULTS.balanceMode as balanceMode,
    attendanceEnabled: true,
    timezone: "Europe/Prague",
  });

  return { organizationId, support, olga, mia, miaEmployment: miaEmployment!.id };
};

type Seeded = Awaited<ReturnType<typeof seed>>;
type HistoryEntry = { eventType: string; channel: ChangeChannel };
type AttendanceEntry = { eventType: string; channel: ChangeChannel };
type ReadLogRow = { kind: string; channel: ChangeChannel };

describe("the channel each change came through", () => {
  let server: LoopbackServer;
  let s: Seeded;

  beforeAll(async () => {
    server = await listenOnLoopback(createServer());
  });

  beforeEach(async () => {
    await db.delete(attendanceSessions);
    await cleanupTestData();
    await resetReportData();
    s = await seed();
  });

  afterAll(async () => {
    await server?.close();
    await db.delete(attendanceSessions);
    await cleanupTestData();
    await resetReportData();
  });

  const historyOf = async (vacationId: string, readerId: string): Promise<HistoryEntry[]> => {
    const res = await (await apiAs(server.url, readerId)).get(`/api/vacation/${vacationId}`);
    expect(res.status).toBe(200);
    return (res.body as { history: HistoryEntry[] }).history;
  };

  describe("the request timeline", () => {
    it("records `app` for a request made in the app", async () => {
      const api = await apiAs(server.url, s.mia.id);
      const created = await api
        .post("/api/vacation/create-vacation", { groupId: s.support, from: WED, to: WED })
        .expect(201);
      const [row] = created.body as { id: string }[];

      expect(await historyOf(row!.id, s.mia.id)).toEqual([
        expect.objectContaining({ eventType: "CREATED", channel: "app" }),
      ]);
    });

    it("records the Assistant on a request it made, and each later change's own channel", async () => {
      const [row] = await createRequest({
        auth: through(s.mia, "assistant"),
        input: validatePostVacation.parse({ groupId: s.support, from: WED, to: WED }),
      });
      await approveRequest({
        auth: through(s.olga, "assistant"),
        vacationId: row!.id,
        reason: null,
      });
      await cancelRequest({ auth: through(s.mia, "mcp"), vacationId: row!.id, reason: null });

      expect(await historyOf(row!.id, s.mia.id)).toEqual([
        expect.objectContaining({ eventType: "CREATED", channel: "assistant" }),
        expect.objectContaining({ eventType: "APPROVED", channel: "assistant" }),
        expect.objectContaining({ eventType: "CANCELLED", channel: "mcp" }),
      ]);
    });
  });

  describe("the attendance history", () => {
    it("records the channel of a clock-in and a clock-out", async () => {
      const opened = await clockInOwn({
        auth: through(s.mia, "assistant"),
        organizationId: s.organizationId,
      });
      await clockOutOwn({ auth: through(s.mia, "mcp"), organizationId: s.organizationId });

      const res = await (
        await apiAs(server.url, s.mia.id)
      )
        .get(`/api/attendance/sessions/${opened.id}/events`)
        .expect(200);
      expect((res.body as { events: AttendanceEntry[] }).events).toEqual([
        expect.objectContaining({ eventType: "CLOCK_IN", channel: "assistant" }),
        expect.objectContaining({ eventType: "CLOCK_OUT", channel: "mcp" }),
      ]);
    });

    it("records `app` for a clock-in in the app", async () => {
      const api = await apiAs(server.url, s.mia.id);
      const opened = await api
        .post("/api/attendance/clock-in", { organizationId: s.organizationId })
        .expect(201);

      const res = await api
        .get(`/api/attendance/sessions/${(opened.body as { id: string }).id}/events`)
        .expect(200);
      expect((res.body as { events: AttendanceEntry[] }).events).toEqual([
        expect.objectContaining({ eventType: "CLOCK_IN", channel: "app" }),
      ]);
    });
  });

  describe("the Read log", () => {
    it("records the channel a Sensitive section was shown through", async () => {
      await showProfileSection({
        auth: through(s.olga, "mcp"),
        organizationId: s.organizationId,
        employmentId: s.miaEmployment,
        section: "contact",
      });
      const api = await apiAs(server.url, s.olga.id);
      await api
        .post(`/api/directory/${s.organizationId}/people/${s.miaEmployment}/show/contact`)
        .expect(200);

      const res = await api.get(`/api/directory/${s.organizationId}/read-log`).expect(200);
      expect((res.body as { entries: ReadLogRow[] }).entries).toEqual([
        expect.objectContaining({ kind: "read", channel: "app" }),
        expect.objectContaining({ kind: "read", channel: "mcp" }),
      ]);
    });
  });
});

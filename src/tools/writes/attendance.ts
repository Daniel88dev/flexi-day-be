import { z } from "zod";
import {
  clockInOwn,
  clockOutOwn,
  previewClockInOwn,
  previewClockOutOwn,
} from "../../services/attendance/ownAttendance.js";
import { defineTool } from "../types.js";
import { DESTRUCTIVE, WRITE_NOTE, type WritePreview } from "./preview.js";

const MINUTE_MS = 60 * 1000;

export const clockInTool = defineTool({
  name: "clock_in",
  description:
    "Clocks you in now in this organization: starts an attendance session at the server's time. Refused when you are already clocked in, when attendance is off for you, or for an external worker. Your own clock only." +
    WRITE_NOTE,
  input: z.object({}),
  annotations: { title: "Clock in", ...DESTRUCTIVE },
  kind: "write",
  userText: [],
  handler: async (ctx) => {
    const session = await clockInOwn({ auth: ctx.auth, organizationId: ctx.organizationId });
    return {
      sessionId: session.id,
      startedAt: session.startedAt,
      businessDate: session.businessDate,
      timezone: session.timezone,
    };
  },
  preview: async (ctx) => {
    const plan = await previewClockInOwn({ auth: ctx.auth, organizationId: ctx.organizationId });
    const details: WritePreview = {
      action: "clock_in",
      at: plan.at.toISOString(),
      businessDate: plan.businessDate,
      timezone: plan.timezone,
    };
    return { userText: [], details };
  },
});

export const clockOutTool = defineTool({
  name: "clock_out",
  description:
    "Clocks you out now in this organization: ends your open attendance session at the server's time, and a break you are on with it. Refused when you are not clocked in. Your own clock only." +
    WRITE_NOTE,
  input: z.object({}),
  annotations: { title: "Clock out", ...DESTRUCTIVE },
  kind: "write",
  userText: [],
  handler: async (ctx) => {
    const session = await clockOutOwn({ auth: ctx.auth, organizationId: ctx.organizationId });
    return {
      sessionId: session.id,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      businessDate: session.businessDate,
      timezone: session.timezone,
      breaks: session.breaks.map(({ startedAt, endedAt }) => ({ startedAt, endedAt })),
    };
  },
  preview: async (ctx) => {
    const plan = await previewClockOutOwn({ auth: ctx.auth, organizationId: ctx.organizationId });
    const details: WritePreview = {
      action: "clock_out",
      at: plan.at.toISOString(),
      startedAt: plan.session.startedAt.toISOString(),
      businessDate: plan.session.businessDate,
      timezone: plan.session.timezone,
      onBreak: plan.onBreak,
      sessionMinutes: Math.floor(
        (plan.at.getTime() - plan.session.startedAt.getTime()) / MINUTE_MS
      ),
    };
    return { userText: [], details };
  },
});

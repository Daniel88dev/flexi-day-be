import { z } from "zod";
import {
  readOwnAttendanceMonth,
  readOwnAttendanceState,
} from "../../services/attendance/ownAttendance.js";
import { defineTool } from "../types.js";
import { monthFields, monthOf } from "./monthInput.js";

type Session = {
  startedAt: Date;
  endedAt: Date | null;
  closedBy: string | null;
  breaks: { startedAt: Date; endedAt: Date | null }[];
};

const sessionView = (session: Session) => ({
  startedAt: session.startedAt,
  endedAt: session.endedAt,
  closedBy: session.closedBy,
  breaks: session.breaks.map(({ startedAt, endedAt }) => ({ startedAt, endedAt })),
});

export const getMyAttendanceTool = defineTool({
  name: "get_my_attendance",
  description:
    "Your attendance clock today in this organization: whether attendance is on for you, whether you are clocked in or on a break, and today's sessions with their start and end instants (ISO 8601, UTC). `today` is the business date in the organization's time zone. Your own record only.",
  input: z.object({}),
  annotations: { title: "Your attendance today", readOnlyHint: true, openWorldHint: false },
  kind: "read",
  userText: [],
  handler: async (ctx) => {
    const state = await readOwnAttendanceState({
      auth: ctx.auth,
      organizationId: ctx.organizationId,
    });
    return {
      active: state.active,
      externalWorker: state.externalWorker,
      employmentEnded: state.employmentEnded,
      timezone: state.timezone,
      today: state.businessDate,
      clockedIn: state.openSession !== null,
      onBreak: state.openBreak !== null,
      sessionsToday: state.sessions.map(sessionView),
    };
  },
});

export const getMyWorkedTimeTool = defineTool({
  name: "get_my_worked_time",
  description:
    "Your worked time for one month in this organization, as the My attendance page shows it: the month's totals (presence, worked and required minutes, the balance, flagged days) and one entry per day that has a session, a day off, or required time already due. Minutes are whole numbers; a negative balance means time short. Your own record only.",
  input: z.object(monthFields),
  annotations: { title: "Your worked time", readOnlyHint: true, openWorldHint: false },
  kind: "read",
  // A holiday or non-working day can carry a name an admin typed.
  userText: ["days[].dayOff.label"],
  handler: async (ctx, input) => {
    const { year, month } = monthOf(input);
    const answer = await readOwnAttendanceMonth({
      auth: ctx.auth,
      query: { organizationId: ctx.organizationId, year, month },
    });
    return {
      year: answer.year,
      month: answer.month,
      timezone: answer.timezone,
      balanceMode: answer.balanceMode,
      requiredMinutesPerDay: answer.requiredMinutesPerDay,
      totals: answer.totals,
      days: answer.days
        .filter(
          (entry) =>
            entry.sessions.length > 0 ||
            entry.exclusion !== null ||
            (!entry.upcoming && entry.requiredMinutes > 0)
        )
        .map((entry) => ({
          date: entry.businessDate,
          presenceMinutes: entry.presenceMinutes,
          breaksMinutes: entry.breaksMinutes,
          workedMinutes: entry.workedMinutes,
          requiredMinutes: entry.requiredMinutes,
          balanceMinutes: entry.balanceMinutes,
          open: entry.open,
          flagged: entry.flagged,
          dayOff: entry.exclusion,
        })),
    };
  },
});

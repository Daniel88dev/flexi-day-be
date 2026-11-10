import { z } from "zod";
import {
  cancelOwnRequest,
  createOwnRequest,
  previewCancelOwnRequest,
  previewOwnRequest,
  type OwnRequestInput,
} from "../../services/vacation/ownRequests.js";
import { REQUESTABLE_CALENDAR_RECORD_TYPES } from "../../services/vacation/types.js";
import { defineTool } from "../types.js";
import { withDayRange } from "../reads/dayRange.js";
import {
  allowanceChanges,
  DESTRUCTIVE,
  weightedDays,
  WRITE_NOTE,
  type WritePreview,
} from "./preview.js";

const MAX_DAYS = 366;

const createInput = withDayRange(MAX_DAYS, {
  groupId: z
    .uuid()
    .optional()
    .describe(
      "The group to book in. Leave out when you book time off in only one group in this organization; the `groupId` of your earlier requests (list_my_requests) names a group."
    ),
  type: z
    .enum(REQUESTABLE_CALENDAR_RECORD_TYPES)
    .optional()
    .describe("The record type. Defaults to VACATION. OTHER needs a note saying what it is."),
  halfDay: z
    .boolean()
    .optional()
    .describe("Book half a day. Only for a single-day request (`from` equals `to`)."),
  note: z
    .string()
    .max(1000)
    .optional()
    .describe("A note for the approver, word for word as the user wants it."),
})
  .refine((input) => !input.halfDay || input.from === input.to, { path: ["halfDay"] })
  .refine((input) => String(input.type) !== "OTHER" || Boolean(input.note?.trim()), {
    path: ["note"],
  });

type CreateInput = z.infer<typeof createInput>;

const ownInput = (input: CreateInput): OwnRequestInput => ({
  groupId: input.groupId,
  from: input.from,
  to: input.to,
  vacationType: input.type,
  halfDay: input.halfDay ?? false,
  note: input.note ?? null,
});

export const createRequestTool = defineTool({
  name: "create_request",
  description: `Books time off for you (vacation, home office, sick day or other leave) in this organization, from \`from\` to \`to\` inclusive, as one request waiting for approval. Non-working days and public holidays in the range are skipped. The same rules as in the app apply: your allowance, the bookable years, the plan. Books only for you, never for someone else. Answers the request with its \`requestId\`.${WRITE_NOTE}`,
  input: createInput,
  annotations: { title: "Request time off", ...DESTRUCTIVE },
  kind: "write",
  fence: { groupId: "group" },
  userText: ["note"],
  handler: async (ctx, input) => {
    const rows = await createOwnRequest({
      auth: ctx.auth,
      organizationId: ctx.organizationId,
      input: ownInput(input),
    });
    const [first] = rows;
    const days = rows.map((row) => row.requestedDay).sort();
    return {
      requestId: first?.requestId ?? null,
      groupId: first?.groupId ?? null,
      type: first?.vacationType ?? null,
      status: "pending",
      firstDay: days[0] ?? null,
      lastDay: days[days.length - 1] ?? null,
      bookedDays: days,
      days: weightedDays(rows),
      note: first?.note ?? null,
    };
  },
  preview: async (ctx, input) => {
    const own = ownInput(input);
    const plan = await previewOwnRequest({
      auth: ctx.auth,
      organizationId: ctx.organizationId,
      input: own,
    });
    const days = plan.days.length * (own.halfDay ? 0.5 : 1);
    const details: WritePreview = {
      action: "create_request",
      group: plan.group,
      type: plan.vacationType,
      firstDay: own.from,
      lastDay: own.to,
      halfDay: own.halfDay,
      bookedDays: plan.days,
      days,
      note: own.note,
      allowances: allowanceChanges(plan.allowances, -1),
    };
    return { userText: ["group.name", "note"], details };
  },
});

const cancelInput = z.object({
  requestId: z
    .uuid()
    .describe("The `requestId` of one of your own requests, as list_my_requests answers it."),
  reason: z
    .string()
    .max(1000)
    .optional()
    .describe("Why you cancel, word for word as the user wants it. Optional."),
});

export const cancelMyRequestTool = defineTool({
  name: "cancel_my_request",
  description:
    "Cancels one of your own requests in this organization, pending or approved: every day of it that is not cancelled or rejected yet. Approvers are told when an approved request is cancelled. Only your own requests; someone else's answers as not found." +
    WRITE_NOTE,
  input: cancelInput,
  annotations: { title: "Cancel your request", ...DESTRUCTIVE },
  kind: "write",
  userText: [],
  handler: async (ctx, input) => {
    const rows = await cancelOwnRequest({
      auth: ctx.auth,
      organizationId: ctx.organizationId,
      requestId: input.requestId,
      reason: input.reason ?? null,
    });
    const days = rows.map((row) => row.requestedDay).sort();
    return {
      requestId: input.requestId,
      status: "cancelled",
      firstDay: days[0] ?? null,
      lastDay: days[days.length - 1] ?? null,
      cancelledDays: days,
      days: weightedDays(rows),
    };
  },
  preview: async (ctx, input) => {
    const { group, rows, allowances } = await previewCancelOwnRequest({
      auth: ctx.auth,
      organizationId: ctx.organizationId,
      requestId: input.requestId,
    });
    const approved = rows.filter((row) => row.approvedAt !== null).length;
    const days = rows.map((row) => row.requestedDay);
    const details: WritePreview = {
      action: "cancel_my_request",
      requestId: input.requestId,
      group,
      type: rows[0]!.vacationType,
      status:
        approved === rows.length ? "approved" : approved === 0 ? "pending" : "partly_approved",
      firstDay: days[0]!,
      lastDay: days[days.length - 1]!,
      cancelledDays: days,
      days: weightedDays(rows),
      note: rows[0]!.note,
      reason: input.reason ?? null,
      allowances: allowanceChanges(allowances, 1),
    };
    return { userText: ["group.name", "note", "reason"], details };
  },
});

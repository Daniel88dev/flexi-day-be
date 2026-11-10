import { z } from "zod";
import {
  approveRequestInOrganization,
  previewRequestDecision,
  rejectRequestInOrganization,
} from "../../services/vacation/requestDecisions.js";
import type { VacationType } from "../../services/vacation/types.js";
import type { ToolContext } from "../types.js";
import { defineTool } from "../types.js";
import {
  balanceChanges,
  DESTRUCTIVE,
  weightedDays,
  WRITE_NOTE,
  type WritePreview,
} from "./preview.js";

const requestIdField = z
  .uuid()
  .describe(
    "The `requestId` of a request waiting for your approval, as list_requests_to_approve answers it."
  );

const DECISION_NOTE =
  " Only when the user asks for this decision: never suggest approving or rejecting a request.";

const preview = async (
  ctx: ToolContext,
  input: { requestId: string; reason?: string },
  action: "approve_request" | "reject_request"
) => {
  const decision = await previewRequestDecision({
    auth: ctx.auth,
    organizationId: ctx.organizationId,
    requestId: input.requestId,
    decision: action === "approve_request" ? "approve" : "reject",
  });
  const days = decision.rows.map((row) => row.requestedDay);
  const details: WritePreview = {
    action,
    requestId: input.requestId,
    requester: decision.requester,
    group: decision.group,
    type: decision.rows[0]!.vacationType,
    firstDay: days[0]!,
    lastDay: days[days.length - 1]!,
    decidedDays: days,
    days: weightedDays(decision.rows),
    note: decision.rows.find((row) => row.note)?.note ?? null,
    noteAuthor: decision.noteAuthor?.name ?? null,
    reason: action === "reject_request" ? (input.reason ?? null) : null,
    balances: balanceChanges(decision.allowances, action === "approve_request"),
  };
  return {
    userText: ["requester.name", "group.name", "note", "noteAuthor", "reason"],
    details,
  };
};

const resultOf = (rows: VacationType[], requestId: string, status: "approved" | "rejected") => {
  const days = rows.map((row) => row.requestedDay).sort();
  return {
    requestId,
    status,
    requester: { id: rows[0]?.userId ?? null },
    firstDay: days[0] ?? null,
    lastDay: days[days.length - 1] ?? null,
    decidedDays: days,
    days: weightedDays(rows),
  };
};

export const approveRequestTool = defineTool({
  name: "approve_request",
  description: `Approves a request waiting for your approval in this organization: every day of it still waiting. The same rules as in the app apply: you must approve in that group, and the requester's allowance must cover it. The requester is notified.${DECISION_NOTE}${WRITE_NOTE}`,
  input: z.object({ requestId: requestIdField }),
  annotations: { title: "Approve a request", ...DESTRUCTIVE },
  kind: "write",
  assistantOnly: true,
  userText: [],
  handler: async (ctx, input) =>
    resultOf(
      await approveRequestInOrganization({
        auth: ctx.auth,
        organizationId: ctx.organizationId,
        requestId: input.requestId,
      }),
      input.requestId,
      "approved"
    ),
  preview: (ctx, input) => preview(ctx, input, "approve_request"),
});

export const rejectRequestTool = defineTool({
  name: "reject_request",
  description: `Rejects a request waiting for your approval in this organization: every day of it still waiting. You must approve in that group. The requester is notified, with the reason if there is one; the user can still write or change the reason on the card. The result says whether a reason was given, not its text.${DECISION_NOTE}${WRITE_NOTE}`,
  input: z.object({
    requestId: requestIdField,
    reason: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .optional()
      .describe("A reason for the requester, word for word as the user wants it. Optional."),
  }),
  annotations: { title: "Reject a request", ...DESTRUCTIVE },
  kind: "write",
  assistantOnly: true,
  userText: [],
  handler: async (ctx, input) => {
    const reason = input.reason ?? null;
    const rows = await rejectRequestInOrganization({
      auth: ctx.auth,
      organizationId: ctx.organizationId,
      requestId: input.requestId,
      reason,
    });
    return { ...resultOf(rows, input.requestId, "rejected"), reasonGiven: reason !== null };
  },
  preview: (ctx, input) => preview(ctx, input, "reject_request"),
});

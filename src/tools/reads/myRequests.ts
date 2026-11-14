import { z } from "zod";
import { listOwnRequestsWithRejecter } from "../../services/vacation/requestReads.js";
import { authorsOf, withTextAuthors } from "../textAuthors.js";
import { defineTool } from "../types.js";
import { toHalfOpen, withDayRange } from "./dayRange.js";
import { cursorField, page } from "./paging.js";
import { summarizeRequests } from "./requestRows.js";

const MAX_DAYS = 366;

export const listMyRequestsTool = defineTool({
  name: "list_my_requests",
  description: `Your own requests (vacation, home office, sick days and other leave) in this organization with at least one day between \`from\` and \`to\`, oldest first, one entry per request and status: pending, approved, rejected or cancelled. Each entry has its first and last day, the number of days (a half day counts 0.5), your note and any rejection reason. Pages of 50; pass \`nextCursor\` back as \`cursor\` for the next page.`,
  input: withDayRange(MAX_DAYS, {
    includeCancelled: z
      .boolean()
      .optional()
      .describe("Also list cancelled requests. Defaults to false."),
    cursor: cursorField,
  }),
  annotations: { title: "Your requests", readOnlyHint: true, openWorldHint: false },
  kind: "read",
  userText: ["requests[].note", "requests[].rejectionReason"],
  handler: async (ctx, input) => {
    const rows = await listOwnRequestsWithRejecter({
      auth: ctx.auth,
      range: toHalfOpen(input),
      options: { includeCancelled: input.includeCancelled ?? false, wholeRequests: true },
      organizationId: ctx.organizationId,
    });
    const { items, nextCursor } = page(summarizeRequests(rows), input.cursor);
    return withTextAuthors(
      {
        requests: items.map(
          ({
            personId: _personId,
            personName: _personName,
            rejectionReasonAuthor: _author,
            ...request
          }) => request
        ),
        nextCursor,
      },
      authorsOf(
        items,
        (request) => [request.rejectionReason],
        (request) => request.rejectionReasonAuthor
      )
    );
  },
});

import { z } from "zod";
import { listRequestsToApprove } from "../../services/vacation/requestDecisions.js";
import { authorsOf, withTextAuthors } from "../textAuthors.js";
import { defineTool } from "../types.js";
import { cursorField, page } from "./requestRows.js";

export const listRequestsToApproveTool = defineTool({
  name: "list_requests_to_approve",
  description: `The requests waiting for your approval in this organization, as the app's Approvals list shows them: one entry per request with its \`requestId\`, the requester, the group, the type, the first and last day, the waiting days and the requester's note with who wrote it. Pages of 50; pass \`nextCursor\` back as \`cursor\` for the next page.`,
  input: z.object({ cursor: cursorField }),
  annotations: {
    title: "Requests waiting for your approval",
    readOnlyHint: true,
    openWorldHint: false,
  },
  kind: "read",
  userText: [
    "requests[].requester.name",
    "requests[].group.name",
    "requests[].note",
    "requests[].noteAuthor",
  ],
  handler: async (ctx, input) => {
    const requests = await listRequestsToApprove({
      auth: ctx.auth,
      organizationId: ctx.organizationId,
    });
    const { items, nextCursor } = page(requests, input.cursor);
    return withTextAuthors(
      {
        requests: items.map((request) => ({
          requestId: request.requestId,
          requester: request.requester,
          group: request.group,
          type: request.type,
          firstDay: request.firstDay,
          lastDay: request.lastDay,
          waitingDays: request.days,
          days: request.days.length,
          note: request.note,
          noteAuthor: request.noteAuthor?.name ?? null,
          submittedAt: request.submittedAt,
        })),
        nextCursor,
      },
      authorsOf(
        items,
        (request) => [request.note],
        (request) =>
          request.noteAuthor
            ? { userId: request.noteAuthor.id, name: request.noteAuthor.name }
            : null
      )
    );
  },
});

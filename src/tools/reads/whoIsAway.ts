import { z } from "zod";
import { listViewableGroups, listWhoIsAway } from "../../services/vacation/requestReads.js";
import { authorsOf, withTextAuthors } from "../textAuthors.js";
import { defineTool } from "../types.js";
import { toHalfOpen, withDayRange } from "./dayRange.js";
import { cursorField, page } from "./paging.js";
import { summarizeRequests, type RequestSummary } from "./requestRows.js";

const MAX_DAYS = 62;

export const listWhoIsAwayTool = defineTool({
  name: "list_who_is_away",
  description: `Who is away or working from home between \`from\` and \`to\`: approved and pending requests of the people in one group, or in every group of this organization whose calendar you may view. One entry per person and request, oldest first, with the type, status, first and last day and the number of days. You see what the app shows you: a teammate's sick leave appears as AWAY, and notes only where you approve or administer the group. \`groups\` lists the groups searched. Pages of 50; pass \`nextCursor\` back as \`cursor\` for the next page.`,
  input: withDayRange(MAX_DAYS, {
    groupId: z
      .string()
      .min(1)
      .optional()
      .describe("One group's id. Leave out to search every group you may view."),
    cursor: cursorField,
  }),
  annotations: { title: "Who is away", readOnlyHint: true, openWorldHint: false },
  kind: "read",
  fence: { groupId: "group" },
  userText: ["groups[].groupName", "absences[].personName", "absences[].note"],
  handler: async (ctx, input) => {
    const viewable = await listViewableGroups({
      auth: ctx.auth,
      organizationId: ctx.organizationId,
    });
    const groupIds = input.groupId ? [input.groupId] : viewable.map((group) => group.groupId);

    const seen = new Set<string>();
    const absences: Omit<RequestSummary, "rejectionReason" | "rejectionReasonAuthor">[] = [];
    for (const groupId of groupIds) {
      const rows = await listWhoIsAway({
        auth: ctx.auth,
        groupId,
        range: toHalfOpen(input),
        options: { wholeRequests: true },
      });
      for (const {
        rejectionReason: _reason,
        rejectionReasonAuthor: _author,
        ...entry
      } of summarizeRequests(rows)) {
        const key = `${entry.requestId}:${entry.status}`;
        if (seen.has(key) || (entry.status !== "approved" && entry.status !== "pending")) continue;
        seen.add(key);
        absences.push(entry);
      }
    }
    absences.sort((a, b) => a.firstDay.localeCompare(b.firstDay));

    const { items, nextCursor } = page(absences, input.cursor);
    return withTextAuthors(
      {
        groups: viewable.filter((group) => groupIds.includes(group.groupId)),
        absences: items,
        nextCursor,
      },
      authorsOf(
        items,
        (entry) => [entry.note],
        (entry) => ({ userId: entry.personId, name: entry.personName })
      )
    );
  },
});

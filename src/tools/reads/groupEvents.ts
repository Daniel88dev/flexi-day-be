import { z } from "zod";
import { listGroupEventsForMonth } from "../../services/groupEvent/groupEventAccess.js";
import { occurrences } from "../../services/groupEvent/occurrences.js";
import { authorsOf, withTextAuthors } from "../textAuthors.js";
import { defineTool } from "../types.js";
import { cursorField, page } from "./paging.js";
import { monthDays, monthFields, monthOf } from "./monthInput.js";

export const listGroupEventsTool = defineTool({
  name: "list_group_events",
  description: `Group events (team lunches, meetings, offsites) in one month: of one group, or of every group of this organization you belong to. One entry per event with its group, title, note, times (\`HH:MM\`, null for all day), how it repeats, and \`dates\`: each of its occurrences that touches the month, both ends inclusive. Pages of 50; pass \`nextCursor\` back as \`cursor\` for the next page.`,
  input: z.object({
    ...monthFields,
    groupId: z
      .string()
      .min(1)
      .optional()
      .describe("One group's id. Leave out for every group you belong to."),
    cursor: cursorField,
  }),
  annotations: { title: "Group events", readOnlyHint: true, openWorldHint: false },
  kind: "read",
  fence: { groupId: "group" },
  userText: ["events[].groupName", "events[].title", "events[].note", "events[].createdByName"],
  handler: async (ctx, input) => {
    const { year, month } = monthOf(input);
    const { first, last } = monthDays(year, month);
    const views = await listGroupEventsForMonth({
      auth: ctx.auth,
      query: { year, month, ...(input.groupId ? { groupId: input.groupId } : {}) },
      organizationId: ctx.organizationId,
    });

    const events = views.flatMap((event) => {
      const dates = occurrences(event, first, last);
      if (dates.length === 0) return [];
      return [
        {
          id: event.id,
          groupId: event.groupId,
          groupName: event.groupName,
          title: event.title,
          note: event.note,
          startTime: event.startTime,
          endTime: event.endTime,
          repeats: event.repeat?.freq ?? null,
          dates,
          createdByName: event.createdBy?.name ?? null,
        },
      ];
    });
    events.sort(
      (a, b) =>
        a.dates[0]!.startDate.localeCompare(b.dates[0]!.startDate) ||
        (a.startTime ?? "").localeCompare(b.startTime ?? "")
    );

    const { items, nextCursor } = page(events, input.cursor);
    const creators = new Map(views.map((view) => [view.id, view.createdBy]));
    return withTextAuthors(
      { year, month, events: items, nextCursor },
      authorsOf(
        items,
        (event) => [event.title, event.note],
        (event) => {
          const creator = creators.get(event.id);
          return creator ? { userId: creator.id, name: creator.name } : null;
        }
      )
    );
  },
});

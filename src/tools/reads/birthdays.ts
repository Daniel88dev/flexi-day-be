import { z } from "zod";
import { listBirthdaysForMonth } from "../../services/birthday/birthdayCalendar.js";
import { listViewableGroups } from "../../services/vacation/requestReads.js";
import { defineTool } from "../types.js";
import { cursorField, page } from "./requestRows.js";
import { monthDays, monthFields, monthOf } from "./monthInput.js";

type Row = Awaited<ReturnType<typeof listBirthdaysForMonth>>[number];

export const listBirthdaysTool = defineTool({
  name: "list_birthdays",
  description: `Birthdays in one month, as the calendar shows them: your own, plus the birthdays people chose to share with the groups of this organization whose whole calendar you may view (or with one such group). Each entry has the person, the date in that year and their age when they shared their birth year. Pages of 50; pass \`nextCursor\` back as \`cursor\` for the next page.`,
  input: z.object({
    ...monthFields,
    groupId: z
      .string()
      .min(1)
      .optional()
      .describe("One group's id. Leave out for every group whose calendar you may view."),
    cursor: cursorField,
  }),
  annotations: { title: "Birthdays", readOnlyHint: true, openWorldHint: false },
  kind: "read",
  fence: { groupId: "group" },
  userText: ["birthdays[].name"],
  handler: async (ctx, input) => {
    const { year, month } = monthOf(input);
    const { first, last } = monthDays(year, month);
    const groupIds = input.groupId
      ? [input.groupId]
      : (await listViewableGroups({ auth: ctx.auth, organizationId: ctx.organizationId })).map(
          (group) => group.groupId
        );

    const rows: Row[] = input.groupId
      ? []
      : await listBirthdaysForMonth({ auth: ctx.auth, year, month });
    for (const groupId of groupIds) {
      rows.push(...(await listBirthdaysForMonth({ auth: ctx.auth, year, month, groupId })));
    }

    const seen = new Set<string>();
    const birthdays = rows
      .filter((row) => row.date >= first && row.date <= last)
      .filter((row) => !seen.has(row.userId) && seen.add(row.userId))
      .sort((a, b) => a.date.localeCompare(b.date) || a.user.name.localeCompare(b.user.name))
      .map((row) => ({ personId: row.userId, name: row.user.name, date: row.date, age: row.age }));

    const { items, nextCursor } = page(birthdays, input.cursor);
    return { year, month, birthdays: items, nextCursor };
  },
});

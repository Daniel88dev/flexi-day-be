import { z } from "zod";

export const PAGE_SIZE = 50;

export const cursorField = z
  .string()
  .regex(/^\d{1,6}$/)
  .optional()
  .describe("The `nextCursor` of the previous page. Leave out for the first page.");

/** One page of `items` and the cursor of the next, `null` on the last page. */
export const page = <T>(items: T[], cursor: string | undefined) => {
  const start = cursor ? Number(cursor) : 0;
  const end = start + PAGE_SIZE;
  return {
    items: items.slice(start, end),
    nextCursor: end < items.length ? end.toString() : null,
  };
};

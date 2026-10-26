import { describe, it, expect } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";

import { scrubQueryErrorEvent } from "../../utils/queryError.js";

const QUERY = 'select "id" from "employment" where "private_email" = $1';
const pgError = (message: string, code: string) => Object.assign(new Error(message), { code });

const eventFor = (err: DrizzleQueryError) => ({
  exception: {
    values: [
      ...(err.cause instanceof Error ? [{ type: "Error", value: err.cause.message }] : []),
      { type: "Error", value: err.message },
    ],
  },
});

describe("scrubQueryErrorEvent", () => {
  it("strips the bound values from a captured query error", () => {
    const err = new DrizzleQueryError(QUERY, ["ada@example.com"]);

    const event = scrubQueryErrorEvent(eventFor(err), err);

    expect(event.exception.values).toEqual([{ type: "Error", value: `Failed query: ${QUERY}` }]);
  });

  it("redacts the input a data exception quotes back in the linked cause", () => {
    const err = new DrizzleQueryError(
      QUERY,
      ["ada@example.com"],
      pgError('invalid input syntax for type uuid: "ada@example.com"', "22P02")
    );

    const event = scrubQueryErrorEvent(eventFor(err), err);

    expect(JSON.stringify(event)).not.toContain("ada@example.com");
    expect(event.exception.values[0]?.value).toBe(
      'invalid input syntax for type uuid: "[redacted]"'
    );
  });

  it("leaves an event for any other error untouched", () => {
    const err = new Error("params: kept");
    const event = { exception: { values: [{ type: "Error", value: err.message }] } };

    expect(scrubQueryErrorEvent(event, err)).toEqual({
      exception: { values: [{ type: "Error", value: "params: kept" }] },
    });
  });
});

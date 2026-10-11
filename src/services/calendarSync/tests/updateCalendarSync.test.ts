import { describe, it, expect, vi } from "vitest";

const { updateError } = vi.hoisted(() => ({ updateError: { value: undefined as unknown } }));

vi.mock("../../../db/db.js", () => {
  const tx = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            throw updateError.value;
          },
        }),
      }),
    }),
  };
  return { db: { transaction: async (fn: (t: unknown) => unknown) => fn(tx) } };
});

import { updateCalendarSync } from "../calendarSyncServices.js";
import { calendarSyncScope } from "../../../db/schema/calendar-sync-schema.js";
import { CALENDAR_SYNC_TEAM_SCOPE } from "../../calendarConnection/types.js";
import AppError from "../../../utils/appError.js";

const switchToTeam = () =>
  updateCalendarSync(
    "6c1f8a52-9d3e-4b7a-8f21-3e5d7c9a1b40",
    "e9dl7v5efgnn0cjrmn7hqz3aswwqxg2b",
    { name: "Mine", scope: calendarSyncScope.Team, distinguishMine: false },
    ["0f6b1c1e-6f43-4a39-9f8e-2a1d3c4b5e6f"],
    []
  );

describe("updateCalendarSync", () => {
  it("refuses to turn a connected config TEAM with a 400 the web can map", async () => {
    updateError.value = Object.assign(new Error("Failed query"), {
      cause: { code: "23514", constraint: "calendar_sync_target_me_scope_chk" },
    });

    const thrown = await switchToTeam().catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(400);
    expect((thrown as AppError).errors[0]?.publicContext).toEqual({
      code: CALENDAR_SYNC_TEAM_SCOPE,
    });
  });

  it("lets any other database failure through", async () => {
    const failure = Object.assign(new Error("Failed query"), { cause: { code: "40001" } });
    updateError.value = failure;

    await expect(switchToTeam()).rejects.toBe(failure);
  });
});

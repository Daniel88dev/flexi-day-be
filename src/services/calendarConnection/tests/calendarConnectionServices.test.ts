import { describe, it, expect, vi, beforeEach } from "vitest";

const { selectRows, mockUpdate, mockSet, mockUpdateWhere, updatedRows } = vi.hoisted(() => {
  const selectRows: { value: unknown[][] } = { value: [] };
  const updatedRows: { value: unknown[] } = { value: [] };
  const mockUpdateWhere = vi.fn(() => ({ returning: () => Promise.resolve(updatedRows.value) }));
  const mockSet = vi.fn(() => ({ where: mockUpdateWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockSet }));
  return { selectRows, mockUpdate, mockSet, mockUpdateWhere, updatedRows };
});

vi.mock("../../../db/db.js", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => Promise.resolve(selectRows.value.shift() ?? []) }),
    }),
    update: mockUpdate,
  },
}));

import { attachTarget, assertTargetAttachable } from "../calendarConnectionServices.js";
import { CALENDAR_SYNC_TEAM_SCOPE } from "../types.js";
import { calendarSyncScope } from "../../../db/schema/calendar-sync-schema.js";
import AppError from "../../../utils/appError.js";

const INPUT = {
  configId: "6c1f8a52-9d3e-4b7a-8f21-3e5d7c9a1b40",
  userId: "e9dl7v5efgnn0cjrmn7hqz3aswwqxg2b",
  connectionId: "connection-1",
  timeZone: "Europe/Prague",
};

const rejectionOf = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error("expected a rejection");
};

describe("assertTargetAttachable", () => {
  it("accepts a ME config", () => {
    expect(() => assertTargetAttachable({ scope: calendarSyncScope.Me })).not.toThrow();
  });

  it("refuses a TEAM config with a code the web can map", () => {
    let thrown: unknown;
    try {
      assertTargetAttachable({ scope: calendarSyncScope.Team });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(400);
    expect((thrown as AppError).errors[0]?.publicContext).toEqual({
      code: CALENDAR_SYNC_TEAM_SCOPE,
    });
  });
});

describe("attachTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectRows.value = [];
    updatedRows.value = [];
  });

  it("never gives a TEAM config a connection", async () => {
    selectRows.value = [[{ id: INPUT.configId, scope: calendarSyncScope.Team }]];

    const error = await rejectionOf(attachTarget(INPUT));

    expect(error.statusCode).toBe(400);
    expect(error.errors[0]?.publicContext).toEqual({ code: CALENDAR_SYNC_TEAM_SCOPE });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("answers 404 for a config the caller does not own", async () => {
    const error = await rejectionOf(attachTarget(INPUT));

    expect(error.statusCode).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("attaches a ME config with its zone and marks it due", async () => {
    selectRows.value = [[{ id: INPUT.configId, scope: calendarSyncScope.Me }]];
    const row = { id: INPUT.configId, connectionId: INPUT.connectionId };
    updatedRows.value = [row];

    const result = await attachTarget(INPUT);

    expect(result).toBe(row);
    expect(mockSet).toHaveBeenCalledWith({
      connectionId: INPUT.connectionId,
      timeZone: INPUT.timeZone,
      syncDueAt: expect.any(Date),
      syncAttempts: 0,
      lastError: null,
    });
    expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
  });

  it("refuses when the config turned TEAM between the read and the write", async () => {
    selectRows.value = [
      [{ id: INPUT.configId, scope: calendarSyncScope.Me }],
      [{ id: INPUT.connectionId }],
    ];
    updatedRows.value = [];

    const error = await rejectionOf(attachTarget(INPUT));

    expect(error.statusCode).toBe(400);
    expect(error.errors[0]?.publicContext).toEqual({ code: CALENDAR_SYNC_TEAM_SCOPE });
  });

  it("answers 404 when the write finds no live connection of the caller's", async () => {
    selectRows.value = [[{ id: INPUT.configId, scope: calendarSyncScope.Me }], []];
    updatedRows.value = [];

    const error = await rejectionOf(attachTarget(INPUT));

    expect(error.statusCode).toBe(404);
    expect(error.message).toBe("Calendar connection not found");
  });
});

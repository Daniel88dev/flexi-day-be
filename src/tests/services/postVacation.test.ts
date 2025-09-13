/* 
  Framework: This test is compatible with Vitest and Jest.
  - If using Vitest, vi.* APIs are used; Jest globals are aliased when vi is available.
  - If using Jest, global jest.* APIs are used and vi is undefined.
*/
import type { VacationType, VacationInsertType } from "../../services/types.js";
import * as PostVacationModule from "../../services/postVacation.js";
import * as DbModule from "../../db/db.js";
import { vacation } from "../../db/schema/vacation-schema.js";

// Lightweight compatibility helpers
const isVitest = typeof globalThis?.vi !== "undefined";
const mockFn = isVitest ? (globalThis as any).vi.fn.bind((globalThis as any).vi) : (globalThis as any).jest.fn.bind((globalThis as any).jest);
const spyOn = isVitest ? (globalThis as any).vi.spyOn.bind((globalThis as any).vi) : (globalThis as any).jest.spyOn.bind((globalThis as any).jest);
const resetAllMocks = () => {
  if (isVitest) (globalThis as any).vi.resetAllMocks();
  else (globalThis as any).jest.resetAllMocks();
};
const clearAllMocks = () => {
  if (isVitest) (globalThis as any).vi.clearAllMocks();
  else (globalThis as any).jest.clearAllMocks();
};

describe("postVacation service", () => {
  // Chainable mock builder for db.insert(...).values(...).onConflictDoNothing().returning()
  const buildDbInsertChain = (rowsToReturn: VacationType[] | Promise<VacationType[]>) => {
    const chain: any = {};
    chain.values = mockFn().mockReturnValue(chain);
    chain.onConflictDoNothing = mockFn().mockReturnValue(chain);
    chain.returning = mockFn().mockImplementation(() => rowsToReturn);
    const insertMock = mockFn().mockReturnValue(chain);
    return { insertMock, chain };
  };

  beforeEach(() => {
    clearAllMocks();
    resetAllMocks();
  });

  test("inserts a vacation record and returns the inserted row (happy path)", async () => {
    const sampleRecord: VacationInsertType = { /* minimal valid payload for insert */ } as any;
    const insertedRow: VacationType = { id: "vac_123", userId: "u_1", startDate: "2025-01-02", endDate: "2025-01-05", createdAt: "2025-01-01T00:00:00.000Z" } as any;

    const { insertMock, chain } = buildDbInsertChain([insertedRow]);
    // Monkey-patch the db instance's insert method
    (DbModule as any).db.insert = insertMock;

    const result = await PostVacationModule.postVacation(sampleRecord);

    // Call chain assertions
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock).toHaveBeenCalledWith(vacation);
    expect(chain.values).toHaveBeenCalledWith(sampleRecord);
    expect(chain.onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(chain.returning).toHaveBeenCalledTimes(1);

    // Result assertion
    expect(result).toEqual(insertedRow);
  });

  test("returns undefined when onConflictDoNothing leads to no rows returned (conflict/no-op)", async () => {
    const sampleRecord: VacationInsertType = { /* e.g., duplicate unique key */ } as any;

    const { insertMock } = buildDbInsertChain([]); // returning() => []
    (DbModule as any).db.insert = insertMock;

    const result = await PostVacationModule.postVacation(sampleRecord);

    expect(result).toBeUndefined();
  });

  test("returns the first row when multiple rows are (unexpectedly) returned", async () => {
    const sampleRecord: VacationInsertType = {} as any;
    const row1 = { id: "r1" } as any as VacationType;
    const row2 = { id: "r2" } as any as VacationType;

    const { insertMock } = buildDbInsertChain([row1, row2]);

    (DbModule as any).db.insert = insertMock;

    const result = await PostVacationModule.postVacation(sampleRecord);

    expect(result).toEqual(row1);
  });

  test("propagates errors from the database layer (rejecting returning())", async () => {
    const sampleRecord: VacationInsertType = {} as any;
    const dbError = new Error("database connection lost");

    const { insertMock } = buildDbInsertChain(Promise.reject(dbError));
    (DbModule as any).db.insert = insertMock;

    await expect(PostVacationModule.postVacation(sampleRecord)).rejects.toThrow("database connection lost");
  });

  test("passes through the record object without mutation to values()", async () => {
    const sampleRecord: VacationInsertType = { userId: "u_2", reason: "PTO", startDate: "2025-05-10", endDate: "2025-05-12" } as any;
    const insertedRow: VacationType = { id: "vac_999" } as any;

    const { insertMock, chain } = buildDbInsertChain([insertedRow]);
    (DbModule as any).db.insert = insertMock;

    await PostVacationModule.postVacation(sampleRecord);

    // Ensure the exact object reference was forwarded (no cloning/mutation in this thin wrapper)
    expect(chain.values).toHaveBeenCalledWith(sampleRecord);
  });
});
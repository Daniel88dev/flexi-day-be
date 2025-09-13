/* 
  Tests for getGroupUser service.

  Framework: Vitest (describe, it, expect, vi).
  If your project uses Jest, replace:
    import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
  with:
    import { describe, it, expect, beforeEach, afterEach, jest as vi } from "@jest/globals";
  and adjust mock timers if necessary.

  These tests mock the drizzle-orm db chain:
    db.select().from(groupUsers).where(and(eq(...), eq(...), isNull(...))).limit(1)
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We will import the unit under test. Adjust this import path if your source layout differs.
// Attempt common source locations in order; the first that resolves will be used by the bundler/tsconfig path mapping.
// If your file lives elsewhere, update this import accordingly.
let getGroupUser: (userId: string, groupId: string) => Promise<Array<any>>;

// Because the module under test imports these modules by path,
// we need to mock them BEFORE importing the module to ensure the mocks are used.
const selectSpy = vi.fn();
const fromSpy = vi.fn();
const whereSpy = vi.fn();
const limitSpy = vi.fn();

// Build a chainable stub object for the Drizzle query builder.
// select() -> from() -> where() -> limit()
function resetChain() {
  selectSpy.mockReset();
  fromSpy.mockReset();
  whereSpy.mockReset();
  limitSpy.mockReset();

  // Each function returns the next link in the chain (or data for limit).
  // We'll wire them up below in beforeEach for clarity.
}

const chain: any = {
  select: selectSpy,
  from: fromSpy,
  where: whereSpy,
  limit: limitSpy,
};

// Create placeholders for captured predicate args to validate clauses
let capturedWhereArg: any = undefined;
let capturedFromArg: any = undefined;

// Mock groupUsers table identifier object with fields used in the query
const mockGroupUsers = {
  userId: { __brand: "column:userId" },
  groupId: { __brand: "column:groupId" },
  deletedAt: { __brand: "column:deletedAt" },
};

// We need the actual functions eq, and, isNull invoked by the module under test.
// Instead of implementing their exact behavior, we will return tagged structures
// so we can assert the predicate structure was built correctly.
type Predicate =
  | { type: "eq"; column: any; value: any }
  | { type: "isNull"; column: any }
  | { type: "and"; conditions: Predicate[] };

function eq(column: any, value: any): Predicate {
  return { type: "eq", column, value };
}
function isNull(column: any): Predicate {
  return { type: "isNull", column };
}
function and(...conditions: Predicate[]): Predicate {
  return { type: "and", conditions };
}

// Install module mocks. We use vi.mock with factory to provide our chain and helpers.
vi.mock("../../db/db.js", () => {
  return {
    db: chain,
  };
});

vi.mock("../../db/schema/group-users-schema.js", () => {
  return {
    groupUsers: mockGroupUsers,
  };
});

vi.mock("drizzle-orm", () => {
  return {
    and,
    eq,
    isNull,
  };
});

async function importModule() {
  // Try multiple locations commonly used; adjust as needed:
  // 1) src/services/getGroupUser
  // 2) src/services/get-group-user
  // 3) src/services/group/getGroupUser
  // 4) fallback to relative from test file's perspective if needed
  const candidates = [
    "../../services/getGroupUser.ts",
    "../../services/getGroupUser.js",
    "../../services/get-group-user.ts",
    "../../services/get-group-user.js",
    "../../services/group/getGroupUser.ts",
    "../../services/group/getGroupUser.js",
    // When tests run from compiled output, .js paths may be used:
    "../../services/getGroupUser",
    "../../services/get-group-user",
    "../../services/group/getGroupUser",
  ];
  let lastErr: any = null;

  for (const p of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const mod = await import(p);
      if (typeof mod.getGroupUser === "function") {
        return mod.getGroupUser;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("Could not locate getGroupUser module. Please adjust import paths in test.");
}

beforeEach(async () => {
  resetChain();

  // Wire up chain returns to be chainable and capture args.
  selectSpy.mockImplementation(() => chain);
  fromSpy.mockImplementation((tbl) => {
    capturedFromArg = tbl;
    return chain;
  });
  whereSpy.mockImplementation((predicate) => {
    capturedWhereArg = predicate;
    return chain;
  });
  // limit returns a Promise-like (the query result); we'll control this per-test
  limitSpy.mockImplementation((_n: number) => Promise.resolve([]));

  // Import (or re-import) the module under test after mocks are ready
  getGroupUser = await importModule();
});

afterEach(() => {
  vi.clearAllMocks();
  capturedWhereArg = undefined;
  capturedFromArg = undefined;
});

describe("getGroupUser", () => {
  it("returns an array with single matching GroupUser when present", async () => {
    const mockRow = { id: "row1", userId: "u1", groupId: "g1", deletedAt: null };
    limitSpy.mockResolvedValueOnce([mockRow]);

    const result = await getGroupUser("u1", "g1");

    expect(result).toEqual([mockRow]);

    // Validate the query chain was called correctly
    expect(selectSpy).toHaveBeenCalledTimes(1);
    expect(fromSpy).toHaveBeenCalledTimes(1);
    expect(capturedFromArg).toBe(mockGroupUsers);
    expect(whereSpy).toHaveBeenCalledTimes(1);
    expect(limitSpy).toHaveBeenCalledWith(1);

    // Validate predicate structure: and(eq(userId, "u1"), eq(groupId, "g1"), isNull(deletedAt))
    expect(capturedWhereArg?.type).toBe("and");
    const conditions = (capturedWhereArg as any).conditions;
    expect(Array.isArray(conditions)).toBe(true);
    // Order-sensitive checks (matches implementation order)
    expect(conditions[0]).toEqual({ type: "eq", column: mockGroupUsers.userId, value: "u1" });
    expect(conditions[1]).toEqual({ type: "eq", column: mockGroupUsers.groupId, value: "g1" });
    expect(conditions[2]).toEqual({ type: "isNull", column: mockGroupUsers.deletedAt });
  });

  it("returns empty array when no matching record exists", async () => {
    limitSpy.mockResolvedValueOnce([]);

    const result = await getGroupUser("u-missing", "g-missing");
    expect(result).toEqual([]);
    expect(limitSpy).toHaveBeenCalledWith(1);
  });

  it("excludes soft-deleted records via isNull(deletedAt) predicate", async () => {
    // Even if the database would have returned a deleted record, our WHERE clause must include isNull(deletedAt).
    // We validate the predicate includes the isNull on deletedAt; the actual DB exclusion is guaranteed by Drizzle.
    limitSpy.mockResolvedValueOnce([]);
    await getGroupUser("u1", "g1");
    const conditions = (capturedWhereArg as any)?.conditions ?? [];
    const hasIsNullDeletedAt = conditions.some((c: any) => c?.type === "isNull" && c?.column === mockGroupUsers.deletedAt);
    expect(hasIsNullDeletedAt).toBe(true);
  });

  it("applies both userId and groupId equality filters", async () => {
    limitSpy.mockResolvedValueOnce([]);
    await getGroupUser("user-xyz", "group-123");
    const conditions = (capturedWhereArg as any)?.conditions ?? [];
    const userIdEq = conditions.find((c: any) => c?.type === "eq" && c?.column === mockGroupUsers.userId);
    const groupIdEq = conditions.find((c: any) => c?.type === "eq" && c?.column === mockGroupUsers.groupId);
    expect(userIdEq?.value).toBe("user-xyz");
    expect(groupIdEq?.value).toBe("group-123");
  });

  it("always limits results to 1", async () => {
    const rows = [
      { id: "1", userId: "u1", groupId: "g1", deletedAt: null },
      { id: "2", userId: "u1", groupId: "g1", deletedAt: null },
    ];
    // Even if the backing client could return multiple, the code asks for limit(1).
    // We'll simulate the first being returned to ensure contract is respected.
    limitSpy.mockResolvedValueOnce([rows[0]]);
    const result = await getGroupUser("u1", "g1");
    expect(result).toEqual([rows[0]]);
    expect(limitSpy).toHaveBeenCalledWith(1);
  });

  it("propagates errors from the underlying db client", async () => {
    const err = new Error("DB failure");
    limitSpy.mockRejectedValueOnce(err);

    await expect(getGroupUser("u1", "g1")).rejects.toThrow("DB failure");
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  it("handles unexpected input types gracefully (string coercion expectation)", async () => {
    // The function signature expects string inputs; feeding numbers should still pass through to eq as values.
    limitSpy.mockResolvedValueOnce([]);
    // @ts-expect-error – intentionally mis-typed to test runtime behavior
    await getGroupUser(123, 456);

    const conditions = (capturedWhereArg as any)?.conditions ?? [];
    const userIdEq = conditions.find((c: any) => c?.type === "eq" && c?.column === mockGroupUsers.userId);
    const groupIdEq = conditions.find((c: any) => c?.type === "eq" && c?.column === mockGroupUsers.groupId);
    expect(userIdEq?.value).toBe(123);
    expect(groupIdEq?.value).toBe(456);
  });
});
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockExisting,
  mockSelectWhere,
  mockInserted,
  mockReturning,
  mockUpdateSet,
  mockUpdateWhere,
} = vi.hoisted(() => ({
  mockExisting: vi.fn(),
  mockSelectWhere: vi.fn(),
  mockInserted: vi.fn(),
  mockReturning: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
}));

vi.mock("../../../config.js", () => ({
  config: { dev: { seedEmailDomain: "dev.local" } },
}));

vi.mock("better-auth/crypto", () => ({
  hashPassword: (password: string) => Promise.resolve(`hashed:${password}`),
}));

vi.mock("../../../db/db.js", () => {
  const insert = (table: unknown) => ({
    values: (values: unknown) => {
      mockInserted(table, values);
      return Object.assign(Promise.resolve(), {
        onConflictDoNothing: () => ({ returning: mockReturning }),
      });
    },
  });
  const select = () => ({
    from: () => ({
      where: (condition: unknown) => {
        mockSelectWhere(condition);
        return { limit: mockExisting };
      },
    }),
  });
  return {
    db: {
      select,
      update: () => ({
        set: (values: unknown) => {
          mockUpdateSet(values);
          return { where: mockUpdateWhere };
        },
      }),
      insert,
      transaction: (callback: (tx: unknown) => Promise<unknown>) => callback({ select, insert }),
    },
  };
});

vi.mock("../../group/groupServices.js", () => ({ createGroup: vi.fn() }));
vi.mock("../../groupUser/groupUserServices.js", () => ({ createGroupUser: vi.fn() }));
vi.mock("../../organization/organizationServices.js", () => ({
  ensureOrganizationForUser: vi.fn(),
}));
vi.mock("../../userYearQuotas/userYearQuotasServices.js", () => ({
  upsertUserYearQuota: vi.fn(),
}));

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { account, user } from "../../../db/schema/auth-schema.js";
import { CalendarRecordType, vacation } from "../../../db/schema/vacation-schema.js";
import { vacationEvents, vacationEventType } from "../../../db/schema/vacation-event-schema.js";
import { addVacation, nextWorkingDay, seedUser } from "../devSeedServices.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const insertedInto = (table: unknown) =>
  mockInserted.mock.calls.filter(([t]) => t === table).map(([, values]) => values);

describe("seedUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateWhere.mockResolvedValue(undefined);
  });

  it("gives a new user a better-auth id of 32 alphanumerics, never a UUID", async () => {
    mockExisting.mockResolvedValue([]);

    const seeded = await seedUser({ email: "Dana@dev.local" });

    expect(seeded.created).toBe(true);
    expect(seeded.id).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(seeded.id).not.toMatch(UUID);
    expect(insertedInto(user)).toEqual([
      expect.objectContaining({ id: seeded.id, email: "dana@dev.local" }),
    ]);
    expect(insertedInto(account)).toEqual([
      expect.objectContaining({ userId: seeded.id, accountId: seeded.id }),
    ]);
  });

  it("keeps an existing user's id, even a UUID from before better-auth ids, and re-points its password", async () => {
    const legacyUuidId = "3f0c1f0e-6a54-4d1b-9a55-2f8c0c7f1d11";
    mockExisting.mockResolvedValue([
      { id: legacyUuidId, email: "dana@dev.local", name: "Dana Holt" },
    ]);

    const seeded = await seedUser({ email: "dana@dev.local", password: "Dev-new-password" });

    expect(seeded).toEqual({
      id: legacyUuidId,
      email: "dana@dev.local",
      name: "Dana Holt",
      password: "Dev-new-password",
      created: false,
    });
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ password: "hashed:Dev-new-password" })
    );
    expect(mockInserted).not.toHaveBeenCalled();
  });
});

describe("nextWorkingDay", () => {
  it("steps over the weekend from a Friday", () => {
    expect(nextWorkingDay("2026-10-02")).toBe("2026-10-05");
  });

  it("takes the following weekday mid-week", () => {
    expect(nextWorkingDay("2026-10-06")).toBe("2026-10-07");
  });
});

describe("addVacation", () => {
  const USER_ID = "Xk3vR9qLmT2wYb7nPc4dHs8fJa6gUe1z";
  const booking = {
    userId: USER_ID,
    groupId: "group-1",
    requestedDay: "2026-10-01",
    actorUserId: "Qm7tB2xLp9vRw4sNk6yHc3dFj8gZa5eU",
  };

  const renderedLookup = () => {
    const query = new PgDialect().sqlToQuery(mockSelectWhere.mock.calls[0]![0] as SQL);
    return { sql: query.sql, params: query.params };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockReturning.mockResolvedValue([{ id: "inserted" }]);
  });

  it("inserts nothing when the same rejected booking was already seeded", async () => {
    mockExisting.mockResolvedValue([{ id: "existing-rejected" }]);

    const id = await addVacation({ ...booking, state: "rejected" });

    expect(id).toBeUndefined();
    expect(mockInserted).not.toHaveBeenCalled();
  });

  it("matches a live rejected row for the same user, day and record type", async () => {
    mockExisting.mockResolvedValue([{ id: "existing-rejected" }]);

    await addVacation({ ...booking, state: "rejected", type: CalendarRecordType.HomeOffice });

    const lookup = renderedLookup();
    expect(lookup.sql).toContain('"vacation"."user_id" = $');
    expect(lookup.sql).toContain('"vacation"."requested_day" = $');
    expect(lookup.sql).toContain('"vacation"."vacation_type" = $');
    expect(lookup.sql).toContain('"vacation"."rejected_at" is not null');
    expect(lookup.sql).toContain('"vacation"."deleted_at" is null');
    expect(lookup.params).toEqual(
      expect.arrayContaining([USER_ID, "2026-10-01", CalendarRecordType.HomeOffice])
    );
  });

  it("seeds a rejected booking and its timeline when none exists yet", async () => {
    mockExisting.mockResolvedValue([]);

    const id = await addVacation({ ...booking, state: "rejected" });

    expect(id).toEqual(expect.any(String));
    expect(insertedInto(vacation)).toEqual([
      expect.objectContaining({ id, userId: USER_ID, rejectedAt: expect.any(Date) }),
    ]);
    expect(insertedInto(vacationEvents)).toEqual([
      [
        expect.objectContaining({ vacationId: id, eventType: vacationEventType.Created }),
        expect.objectContaining({ vacationId: id, eventType: vacationEventType.Rejected }),
      ],
    ]);
  });

  it("leaves pending and approved bookings to the unique index", async () => {
    await addVacation({ ...booking, state: "pending" });
    await addVacation({ ...booking, state: "approved" });

    expect(mockExisting).not.toHaveBeenCalled();
    expect(insertedInto(vacation)).toHaveLength(2);
  });

  it("reports nothing created when the index turns the insert into a no-op", async () => {
    mockReturning.mockResolvedValue([]);

    const id = await addVacation({ ...booking, state: "approved" });

    expect(id).toBeUndefined();
    expect(insertedInto(vacationEvents)).toEqual([]);
  });
});

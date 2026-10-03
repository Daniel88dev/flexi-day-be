import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExisting, mockInserted, mockUpdateSet, mockUpdateWhere } = vi.hoisted(() => ({
  mockExisting: vi.fn(),
  mockInserted: vi.fn(),
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
      return Promise.resolve();
    },
  });
  return {
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit: mockExisting }) }) }),
      update: () => ({
        set: (values: unknown) => {
          mockUpdateSet(values);
          return { where: mockUpdateWhere };
        },
      }),
      insert,
      transaction: (callback: (tx: unknown) => Promise<unknown>) => callback({ insert }),
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

import { account, user } from "../../../db/schema/auth-schema.js";
import { nextWorkingDay, seedUser } from "../devSeedServices.js";

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

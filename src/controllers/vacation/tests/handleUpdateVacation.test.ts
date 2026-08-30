import { describe, it, expect, vi, beforeEach } from "vitest";

// Billing plan-limit guards are no-ops here; their behavior has its own suite.
// The Sick day gate keeps a handle so the wiring below can be asserted.
vi.mock("../../../services/billing/guards.js", () => ({
  assertCanCreateGroup: vi.fn(),
  assertCanAddMember: vi.fn(),
  assertGroupWritable: vi.fn(),
  assertGroupsWritable: vi.fn(),
  assertSickDayRequestable: mockAssertSickDayRequestable,
}));

const {
  mockGetVacationsByIds,
  mockUpdateVacationRows,
  mockCreateVacationEvents,
  mockResolveGroupAdmin,
  mockAssertEditWithinQuota,
  mockNotifyVacationUpdated,
  mockAssertSickDayRequestable,
} = vi.hoisted(() => ({
  mockGetVacationsByIds: vi.fn(),
  mockUpdateVacationRows: vi.fn(),
  mockCreateVacationEvents: vi.fn(),
  mockResolveGroupAdmin: vi.fn(),
  mockAssertEditWithinQuota: vi.fn(),
  mockNotifyVacationUpdated: vi.fn(),
  mockAssertSickDayRequestable: vi.fn(),
}));

vi.mock("../../../utils/generateUUID.js", () => ({
  generateRandomUUID: vi.fn(() => "uuid"),
}));

vi.mock("../../../middleware/authSession.js", () => ({
  getAuth: vi.fn(),
}));

vi.mock("../../../services/groupUser/groupAccess.js", () => ({
  resolveGroupAdmin: mockResolveGroupAdmin,
}));

vi.mock("../../../services/vacation/quotaGuard.js", () => ({
  assertEditWithinQuota: mockAssertEditWithinQuota,
}));

vi.mock("../../../services/vacation/vacationNotifier.js", () => ({
  notifyVacationUpdated: mockNotifyVacationUpdated,
}));

vi.mock("../../../db/db.js", () => ({
  db: {
    transaction: vi.fn((callback: (tx: unknown) => unknown) => callback({})),
  },
}));

vi.mock("../../../services/vacation/vacationServices.js", () => ({
  getVacationsByIds: mockGetVacationsByIds,
  updateVacationRows: mockUpdateVacationRows,
}));

vi.mock("../../../services/vacationEvent/vacationEventServices.js", () => ({
  createVacationEvents: mockCreateVacationEvents,
}));

import { handleUpdateVacation } from "../handleUpdateVacation.js";
import { getAuth } from "../../../middleware/authSession.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";
import { CalendarRecordType } from "../../../db/schema/vacation-schema.js";

const groupId = "550e8400-e29b-41d4-a716-446655440009";

const baseRow = (overrides: Record<string, unknown> = {}) => ({
  id: "v-1",
  userId: "member_456",
  groupId,
  requestedDay: "2026-08-20",
  startTime: "09:00:00",
  endTime: "17:00:00",
  vacationType: CalendarRecordType.Vacation,
  halfDay: false,
  approvedAt: null,
  rejectedAt: null,
  deletedAt: null,
  note: null,
  ...overrides,
});

describe("handleUpdateVacation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthData);
    mockResolveGroupAdmin.mockResolvedValue({ canAdmin: true, viaOrgAdmin: false });
    mockGetVacationsByIds.mockResolvedValue([baseRow()]);
    mockUpdateVacationRows.mockImplementation(async (ids: string[]) =>
      ids.map((id) => baseRow({ id }))
    );
  });

  it("updates the rows, writes an UPDATED event with a change summary, and notifies the member", async () => {
    const { req, res } = makeReqRes({
      body: { ids: ["v-1"], vacationType: CalendarRecordType.Sick, halfDay: true },
    });

    await handleUpdateVacation(req, res);

    expect(mockUpdateVacationRows).toHaveBeenCalledWith(
      ["v-1"],
      { vacationType: CalendarRecordType.Sick, halfDay: true },
      expect.anything()
    );
    expect(mockCreateVacationEvents).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          vacationId: "v-1",
          eventType: "UPDATED",
          actorUserId: mockAuthData.userId,
          reason: "Type: Vacation → Sick; Half day: no → yes",
        }),
      ],
      expect.anything()
    );
    expect(mockNotifyVacationUpdated).toHaveBeenCalledWith(expect.any(Array), {
      id: mockAuthData.userId,
      name: mockAuthData.userName,
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("skips the quota guard when only presentation fields change", async () => {
    const { req, res } = makeReqRes({
      body: { ids: ["v-1"], startTime: "10:00:00", note: "Doctor" },
    });

    await handleUpdateVacation(req, res);

    expect(mockAssertEditWithinQuota).not.toHaveBeenCalled();
    expect(mockUpdateVacationRows).toHaveBeenCalled();
  });

  it("runs the quota guard at the post-edit weight when the type changes", async () => {
    const { req, res } = makeReqRes({
      body: { ids: ["v-1"], vacationType: CalendarRecordType.HomeOffice },
    });

    await handleUpdateVacation(req, res);

    expect(mockAssertEditWithinQuota).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "v-1", vacationType: CalendarRecordType.HomeOffice })],
      expect.anything()
    );
  });

  it("passes a retype to Sick day through the benefit gate", async () => {
    const { req, res } = makeReqRes({
      body: { ids: ["v-1"], vacationType: CalendarRecordType.SickDay },
    });

    await handleUpdateVacation(req, res);

    expect(mockAssertSickDayRequestable).toHaveBeenCalledWith(groupId, expect.anything());
  });

  it("leaves records already stored as Sick day editable without the gate", async () => {
    // Dormancy withdraws new grants only; adjusting an existing sick day
    // record (here its half-day weight) must keep working after a lapse.
    const { req, res } = makeReqRes({
      body: { ids: ["v-1"], vacationType: CalendarRecordType.SickDay, halfDay: true },
    });
    mockGetVacationsByIds.mockResolvedValue([
      baseRow({ vacationType: CalendarRecordType.SickDay }),
    ]);

    await handleUpdateVacation(req, res);

    expect(mockAssertSickDayRequestable).not.toHaveBeenCalled();
    expect(mockUpdateVacationRows).toHaveBeenCalled();
  });

  it("does not notify when the admin edits their own record", async () => {
    const { req, res } = makeReqRes({ body: { ids: ["v-1"], note: "mine" } });
    mockGetVacationsByIds.mockResolvedValue([baseRow({ userId: mockAuthData.userId })]);

    await handleUpdateVacation(req, res);

    expect(mockNotifyVacationUpdated).not.toHaveBeenCalled();
  });

  it("rejects a caller without admin standing", async () => {
    const { req, res } = makeReqRes({ body: { ids: ["v-1"], note: "x" } });
    mockResolveGroupAdmin.mockResolvedValue({ canAdmin: false, viaOrgAdmin: false });

    await expect(handleUpdateVacation(req, res)).rejects.toThrow(
      "You are not allowed to edit records in this group"
    );
    expect(mockUpdateVacationRows).not.toHaveBeenCalled();
  });

  it("404s for cancelled or missing ids", async () => {
    const { req, res } = makeReqRes({ body: { ids: ["v-1", "v-2"], note: "x" } });
    mockGetVacationsByIds.mockResolvedValue([baseRow()]);

    await expect(handleUpdateVacation(req, res)).rejects.toThrow("One or more vacations not found");
  });

  it("422s when a one-sided time patch would invert the stored range", async () => {
    const { req, res } = makeReqRes({ body: { ids: ["v-1"], startTime: "18:00:00" } });

    await expect(handleUpdateVacation(req, res)).rejects.toThrow(
      "`endTime` must be later than `startTime`"
    );
    expect(mockUpdateVacationRows).not.toHaveBeenCalled();
  });

  it("accepts a one-sided time patch that keeps the range ordered", async () => {
    const { req, res } = makeReqRes({ body: { ids: ["v-1"], startTime: "10:00:00" } });

    await handleUpdateVacation(req, res);

    expect(mockUpdateVacationRows).toHaveBeenCalledWith(
      ["v-1"],
      { startTime: "10:00:00" },
      expect.anything()
    );
  });

  it("409s on rejected rows — their decision is final", async () => {
    const { req, res } = makeReqRes({ body: { ids: ["v-1"], note: "x" } });
    mockGetVacationsByIds.mockResolvedValue([baseRow({ rejectedAt: new Date() })]);

    await expect(handleUpdateVacation(req, res)).rejects.toThrow(
      "Rejected records cannot be edited"
    );
  });

  it("422s when the batch spans more than one member or group", async () => {
    const { req, res } = makeReqRes({ body: { ids: ["v-1", "v-2"], note: "x" } });
    mockGetVacationsByIds.mockResolvedValue([
      baseRow(),
      baseRow({ id: "v-2", userId: "someone_else" }),
    ]);

    await expect(handleUpdateVacation(req, res)).rejects.toThrow(
      "All records must belong to the same member and group"
    );
  });

  it("409s when a concurrent change dropped a row from the update", async () => {
    const { req, res } = makeReqRes({ body: { ids: ["v-1"], note: "x" } });
    mockUpdateVacationRows.mockResolvedValue([]);

    await expect(handleUpdateVacation(req, res)).rejects.toThrow(
      "One or more records changed while editing — refresh and retry"
    );
    expect(mockNotifyVacationUpdated).not.toHaveBeenCalled();
  });
});

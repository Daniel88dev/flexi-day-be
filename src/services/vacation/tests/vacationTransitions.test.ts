import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  timeline,
  tx,
  mockGetVacationById,
  mockGetVacationsByIds,
  mockApproveVacation,
  mockApproveVacationsBulk,
  mockRejectVacation,
  mockRejectVacationsBulk,
  mockCreateVacationEvent,
  mockCreateVacationEvents,
  mockGetGroupsWhereUserCanApprove,
  mockGetGroupUser,
  mockHasMirrorIntoGroup,
  mockAssertApprovalWithinQuota,
  mockAssertGroupsWritable,
  mockNotifyVacationDecision,
} = vi.hoisted(() => ({
  timeline: [] as string[],
  tx: {},
  mockGetVacationById: vi.fn(),
  mockGetVacationsByIds: vi.fn(),
  mockApproveVacation: vi.fn(),
  mockApproveVacationsBulk: vi.fn(),
  mockRejectVacation: vi.fn(),
  mockRejectVacationsBulk: vi.fn(),
  mockCreateVacationEvent: vi.fn(),
  mockCreateVacationEvents: vi.fn(),
  mockGetGroupsWhereUserCanApprove: vi.fn(),
  mockGetGroupUser: vi.fn(),
  mockHasMirrorIntoGroup: vi.fn(),
  mockAssertApprovalWithinQuota: vi.fn(),
  mockAssertGroupsWritable: vi.fn(),
  mockNotifyVacationDecision: vi.fn(),
}));

vi.mock("../../../db/db.js", () => ({
  db: {
    transaction: vi.fn(async (callback: (handle: unknown) => Promise<unknown>) => {
      const result = await callback(tx);
      timeline.push("commit");
      return result;
    }),
  },
}));

vi.mock("../../DBServices.js", () => ({
  createDBServices: () => ({
    vacation: {
      getVacationById: mockGetVacationById,
      getVacationsByIds: mockGetVacationsByIds,
      approveVacation: mockApproveVacation,
      approveVacationsBulk: mockApproveVacationsBulk,
      rejectVacation: mockRejectVacation,
      rejectVacationsBulk: mockRejectVacationsBulk,
    },
    vacationEvent: {
      createVacationEvent: mockCreateVacationEvent,
      createVacationEvents: mockCreateVacationEvents,
    },
    group: { getGroupsWhereUserCanApprove: mockGetGroupsWhereUserCanApprove },
    groupUser: { getGroupUser: mockGetGroupUser },
    groupMirror: { hasMirrorIntoGroup: mockHasMirrorIntoGroup },
  }),
}));

vi.mock("../../billing/guards.js", () => ({
  assertGroupWritable: vi.fn(),
  assertGroupsWritable: mockAssertGroupsWritable,
}));

vi.mock("../quotaGuard.js", () => ({
  assertApprovalWithinQuota: mockAssertApprovalWithinQuota,
}));

vi.mock("../vacationNotifier.js", () => ({
  notifyVacationDecision: mockNotifyVacationDecision,
}));

import {
  approveRequest,
  approveRequestBatch,
  rejectRequest,
  rejectRequestBatch,
} from "../vacationTransitions.js";
import { mockAuthData } from "../../../tests/testUtils.js";

const FIRST_ID = "550e8400-e29b-41d4-a716-446655440000";
const SECOND_ID = "550e8400-e29b-41d4-a716-446655440001";

const pendingVacation = (over: Record<string, unknown> = {}) => ({
  id: FIRST_ID,
  userId: "vacation_user_123",
  groupId: "group_123",
  requestedDay: "2024-03-15",
  vacationType: "VACATION",
  halfDay: false,
  approvedAt: null,
  rejectedAt: null,
  deletedAt: null,
  ...over,
});

/** Records where each step happened relative to the commit. */
const trackedResolve = <T>(step: string, value: T) =>
  vi.fn(() => {
    timeline.push(step);
    return Promise.resolve(value);
  });

describe("vacationTransitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    timeline.length = 0;

    mockGetGroupsWhereUserCanApprove.mockResolvedValue(["group_123"]);
    mockGetGroupUser.mockResolvedValue({ approverAccess: false });
    mockHasMirrorIntoGroup.mockResolvedValue(false);
    mockAssertApprovalWithinQuota.mockResolvedValue(undefined);
    mockAssertGroupsWritable.mockResolvedValue(undefined);

    mockCreateVacationEvent.mockImplementation(trackedResolve("event", undefined));
    mockCreateVacationEvents.mockImplementation(trackedResolve("event", []));
    mockNotifyVacationDecision.mockImplementation(trackedResolve("notify", undefined));
  });

  describe("ordering", () => {
    it("appends the event inside the transaction and notifies only after it commits", async () => {
      mockGetVacationById.mockResolvedValue(pendingVacation());
      mockApproveVacation.mockImplementation(
        trackedResolve("mutate", pendingVacation({ approvedAt: new Date() }))
      );

      await approveRequest({ auth: mockAuthData, vacationId: FIRST_ID, reason: null });

      expect(timeline).toEqual(["mutate", "event", "commit", "notify"]);
    });

    it("appends the events inside the transaction on the bulk path too", async () => {
      mockGetVacationsByIds.mockResolvedValue([pendingVacation()]);
      mockApproveVacationsBulk.mockImplementation(
        trackedResolve("mutate", [pendingVacation({ approvedAt: new Date() })])
      );

      await approveRequestBatch({ auth: mockAuthData, vacationIds: [FIRST_ID] });

      expect(timeline).toEqual(["mutate", "event", "commit", "notify"]);
    });

    it("does not notify when the transaction throws", async () => {
      mockGetVacationsByIds.mockResolvedValue([pendingVacation()]);
      mockApproveVacationsBulk.mockRejectedValue(new Error("Failed to update vacation"));

      await expect(
        approveRequestBatch({ auth: mockAuthData, vacationIds: [FIRST_ID] })
      ).rejects.toThrow("Failed to update vacation");

      expect(mockNotifyVacationDecision).not.toHaveBeenCalled();
    });
  });

  describe("authorization", () => {
    it("prevents any mutation when the caller may not decide on the group", async () => {
      mockGetVacationById.mockResolvedValue(pendingVacation());
      mockGetGroupsWhereUserCanApprove.mockResolvedValue([]);

      await expect(
        approveRequest({ auth: mockAuthData, vacationId: FIRST_ID, reason: null })
      ).rejects.toThrow("You are not allowed to approve one or more of these requests");

      expect(mockApproveVacation).not.toHaveBeenCalled();
      expect(mockCreateVacationEvent).not.toHaveBeenCalled();
      expect(mockNotifyVacationDecision).not.toHaveBeenCalled();
    });

    it("prevents any mutation when the caller is deciding on their own request", async () => {
      mockGetVacationsByIds.mockResolvedValue([pendingVacation({ userId: "user_123" })]);

      await expect(
        rejectRequestBatch({ auth: mockAuthData, vacationIds: [FIRST_ID], reason: null })
      ).rejects.toThrow("You cannot decide on your own leave request");

      expect(mockRejectVacationsBulk).not.toHaveBeenCalled();
      expect(mockCreateVacationEvents).not.toHaveBeenCalled();
      expect(mockNotifyVacationDecision).not.toHaveBeenCalled();
    });

    it("refuses a request that was already decided before any mutation runs", async () => {
      mockGetVacationById.mockResolvedValue(pendingVacation({ approvedAt: new Date() }));

      await expect(
        approveRequest({ auth: mockAuthData, vacationId: FIRST_ID, reason: null })
      ).rejects.toThrow("This request has already been decided");

      expect(mockApproveVacation).not.toHaveBeenCalled();
    });

    it("refuses to write to a group the plan has turned read-only", async () => {
      mockGetVacationById.mockResolvedValue(pendingVacation());
      mockAssertGroupsWritable.mockRejectedValue(
        new Error("This group is read-only on your current plan")
      );

      await expect(
        approveRequest({ auth: mockAuthData, vacationId: FIRST_ID, reason: null })
      ).rejects.toThrow("This group is read-only on your current plan");

      expect(mockApproveVacation).not.toHaveBeenCalled();
    });

    it("stops an approval that would exceed the requester's allowance", async () => {
      mockGetVacationById.mockResolvedValue(pendingVacation());
      mockAssertApprovalWithinQuota.mockRejectedValue(
        new Error("This would exceed the allowance for that leave type")
      );

      await expect(
        approveRequest({ auth: mockAuthData, vacationId: FIRST_ID, reason: null })
      ).rejects.toThrow("This would exceed the allowance for that leave type");

      expect(mockApproveVacation).not.toHaveBeenCalled();
    });

    it("runs no quota guard on the reject path", async () => {
      mockGetVacationById.mockResolvedValue(pendingVacation());
      mockRejectVacation.mockResolvedValue(pendingVacation({ rejectedAt: new Date() }));

      await rejectRequest({ auth: mockAuthData, vacationId: FIRST_ID, reason: null });

      expect(mockAssertApprovalWithinQuota).not.toHaveBeenCalled();
    });
  });

  describe("wording", () => {
    it("uses the single-record not-found message for a single approval", async () => {
      mockGetVacationById.mockResolvedValue(undefined);

      await expect(
        approveRequest({ auth: mockAuthData, vacationId: FIRST_ID, reason: null })
      ).rejects.toThrow("Vacation not found");
    });

    it("uses the bulk not-found message for a batch approval", async () => {
      mockGetVacationsByIds.mockResolvedValue([pendingVacation()]);

      await expect(
        approveRequestBatch({ auth: mockAuthData, vacationIds: [FIRST_ID, SECOND_ID] })
      ).rejects.toThrow("One or more vacations not found");
    });

    it("uses the single-record conflict message when a single approval loses the race", async () => {
      mockGetVacationById.mockResolvedValue(pendingVacation());
      mockApproveVacation.mockResolvedValue(undefined);

      await expect(
        approveRequest({ auth: mockAuthData, vacationId: FIRST_ID, reason: null })
      ).rejects.toThrow("This request has already been decided");

      expect(mockCreateVacationEvent).not.toHaveBeenCalled();
    });

    it("uses the bulk conflict message when a batch rejection loses the race", async () => {
      mockGetVacationsByIds.mockResolvedValue([
        pendingVacation(),
        pendingVacation({ id: SECOND_ID }),
      ]);
      mockRejectVacationsBulk.mockResolvedValue([pendingVacation({ rejectedAt: new Date() })]);

      await expect(
        rejectRequestBatch({
          auth: mockAuthData,
          vacationIds: [FIRST_ID, SECOND_ID],
          reason: null,
        })
      ).rejects.toThrow("One or more of these requests has already been decided");

      expect(mockCreateVacationEvents).not.toHaveBeenCalled();
    });

    // The wording belongs to the route, not to how many ids happened to arrive.
    it("keeps the bulk wording for a batch carrying exactly one id", async () => {
      mockGetVacationsByIds.mockResolvedValue([pendingVacation()]);
      mockApproveVacationsBulk.mockResolvedValue([]);

      await expect(
        approveRequestBatch({ auth: mockAuthData, vacationIds: [FIRST_ID] })
      ).rejects.toThrow("One or more of these requests has already been decided");
    });

    it("keeps the bulk not-found wording for a batch carrying exactly one id", async () => {
      mockGetVacationsByIds.mockResolvedValue([]);

      await expect(
        approveRequestBatch({ auth: mockAuthData, vacationIds: [FIRST_ID] })
      ).rejects.toThrow("One or more vacations not found");
    });
  });

  describe("event and notification payloads", () => {
    it("stamps an approval event with the approver's note", async () => {
      mockGetVacationById.mockResolvedValue(pendingVacation());
      const approved = pendingVacation({ approvedAt: new Date() });
      mockApproveVacation.mockResolvedValue(approved);

      await approveRequest({
        auth: mockAuthData,
        vacationId: FIRST_ID,
        reason: "Enjoy the break",
      });

      expect(mockCreateVacationEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          vacationId: FIRST_ID,
          eventType: "APPROVED",
          actorUserId: "user_123",
          reason: "Enjoy the break",
        }),
        tx
      );
      expect(mockNotifyVacationDecision).toHaveBeenCalledWith(
        [approved],
        "approved",
        { id: "user_123", name: "Test User" },
        null
      );
    });

    it("carries the rejection reason onto the event and the notification", async () => {
      mockGetVacationById.mockResolvedValue(pendingVacation());
      const rejected = pendingVacation({ rejectedAt: new Date() });
      mockRejectVacation.mockResolvedValue(rejected);

      await rejectRequest({ auth: mockAuthData, vacationId: FIRST_ID, reason: "Too busy" });

      expect(mockRejectVacation).toHaveBeenCalledWith(FIRST_ID, "user_123", "Too busy", tx);
      expect(mockCreateVacationEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "REJECTED", reason: "Too busy" }),
        tx
      );
      expect(mockNotifyVacationDecision).toHaveBeenCalledWith(
        [rejected],
        "rejected",
        { id: "user_123", name: "Test User" },
        "Too busy"
      );
    });

    it("appends one event per row on a batch rejection", async () => {
      const rows = [pendingVacation(), pendingVacation({ id: SECOND_ID })];
      mockGetVacationsByIds.mockResolvedValue(rows);
      mockRejectVacationsBulk.mockResolvedValue(rows);

      await rejectRequestBatch({
        auth: mockAuthData,
        vacationIds: [FIRST_ID, SECOND_ID],
        reason: "Coverage gap",
      });

      expect(mockCreateVacationEvents).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            vacationId: FIRST_ID,
            eventType: "REJECTED",
            reason: "Coverage gap",
          }),
          expect.objectContaining({
            vacationId: SECOND_ID,
            eventType: "REJECTED",
            reason: "Coverage gap",
          }),
        ],
        tx
      );
    });

    it("deduplicates the ids a batch was given", async () => {
      mockGetVacationsByIds.mockResolvedValue([pendingVacation()]);
      mockApproveVacationsBulk.mockResolvedValue([pendingVacation({ approvedAt: new Date() })]);

      await approveRequestBatch({ auth: mockAuthData, vacationIds: [FIRST_ID, FIRST_ID] });

      expect(mockGetVacationsByIds).toHaveBeenCalledWith([FIRST_ID], tx);
      expect(mockApproveVacationsBulk).toHaveBeenCalledWith([FIRST_ID], "user_123", tx);
    });
  });
});

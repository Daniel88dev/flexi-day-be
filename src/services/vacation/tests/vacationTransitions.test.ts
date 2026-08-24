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
  mockDeleteVacation,
  mockCancelVacationsBulk,
  mockCreateVacationEvent,
  mockCreateVacationEvents,
  mockGetGroupsWhereUserCanApprove,
  mockGetGroupUser,
  mockHasMirrorIntoGroup,
  mockAssertApprovalWithinQuota,
  mockAssertGroupsWritable,
  mockResolveGroupAdmin,
  mockResolveVacationPermissions,
  mockNotifyVacationDecision,
  mockNotifyVacationCancelled,
  mockNotifyVacationsCancelled,
  mockNotifyVacationComment,
} = vi.hoisted(() => ({
  timeline: [] as string[],
  tx: {},
  mockGetVacationById: vi.fn(),
  mockGetVacationsByIds: vi.fn(),
  mockApproveVacation: vi.fn(),
  mockApproveVacationsBulk: vi.fn(),
  mockRejectVacation: vi.fn(),
  mockRejectVacationsBulk: vi.fn(),
  mockDeleteVacation: vi.fn(),
  mockCancelVacationsBulk: vi.fn(),
  mockCreateVacationEvent: vi.fn(),
  mockCreateVacationEvents: vi.fn(),
  mockGetGroupsWhereUserCanApprove: vi.fn(),
  mockGetGroupUser: vi.fn(),
  mockHasMirrorIntoGroup: vi.fn(),
  mockAssertApprovalWithinQuota: vi.fn(),
  mockAssertGroupsWritable: vi.fn(),
  mockResolveGroupAdmin: vi.fn(),
  mockResolveVacationPermissions: vi.fn(),
  mockNotifyVacationDecision: vi.fn(),
  mockNotifyVacationCancelled: vi.fn(),
  mockNotifyVacationsCancelled: vi.fn(),
  mockNotifyVacationComment: vi.fn(),
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

vi.mock("../../group/groupServices.js", () => ({
  getGroupsWhereUserCanApprove: mockGetGroupsWhereUserCanApprove,
}));

vi.mock("../../groupMirror/groupMirrorServices.js", () => ({
  hasMirrorIntoGroup: mockHasMirrorIntoGroup,
}));

vi.mock("../../groupUser/groupUserServices.js", () => ({
  getGroupUser: mockGetGroupUser,
}));

vi.mock("../vacationServices.js", () => ({
  getVacationById: mockGetVacationById,
  getVacationsByIds: mockGetVacationsByIds,
  approveVacation: mockApproveVacation,
  approveVacationsBulk: mockApproveVacationsBulk,
  rejectVacation: mockRejectVacation,
  rejectVacationsBulk: mockRejectVacationsBulk,
  deleteVacation: mockDeleteVacation,
  cancelVacationsBulk: mockCancelVacationsBulk,
}));

vi.mock("../../vacationEvent/vacationEventServices.js", () => ({
  createVacationEvent: mockCreateVacationEvent,
  createVacationEvents: mockCreateVacationEvents,
}));

vi.mock("../../billing/guards.js", () => ({
  assertGroupWritable: vi.fn(),
  assertGroupsWritable: mockAssertGroupsWritable,
}));

vi.mock("../quotaGuard.js", () => ({
  assertApprovalWithinQuota: mockAssertApprovalWithinQuota,
}));

vi.mock("../../groupUser/groupAccess.js", () => ({
  resolveGroupAdmin: mockResolveGroupAdmin,
}));

// Only the per-record resolver is stubbed; the set-based cancel verdict runs
// for real against the mocked services, so its query count stays under test.
vi.mock("../vacationPermissions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../vacationPermissions.js")>()),
  resolveVacationPermissions: mockResolveVacationPermissions,
}));

vi.mock("../vacationNotifier.js", () => ({
  notifyVacationDecision: mockNotifyVacationDecision,
  notifyVacationCancelled: mockNotifyVacationCancelled,
  notifyVacationsCancelled: mockNotifyVacationsCancelled,
  notifyVacationComment: mockNotifyVacationComment,
}));

import {
  approveRequest,
  approveRequestBatch,
  cancelRequest,
  cancelRequestBatch,
  commentOnRequest,
  rejectRequest,
  rejectRequestBatch,
} from "../vacationTransitions.js";
import { mockAuthData } from "../../../tests/testUtils.js";

const FIRST_ID = "550e8400-e29b-41d4-a716-446655440000";
const SECOND_ID = "550e8400-e29b-41d4-a716-446655440001";
const THIRD_ID = "550e8400-e29b-41d4-a716-446655440002";

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
    mockResolveGroupAdmin.mockResolvedValue({ canAdmin: false, viaOrgAdmin: false });
    mockResolveVacationPermissions.mockResolvedValue({ canView: true });

    mockCreateVacationEvent.mockImplementation(trackedResolve("event", undefined));
    mockCreateVacationEvents.mockImplementation(trackedResolve("event", []));
    mockNotifyVacationDecision.mockImplementation(trackedResolve("notify", undefined));
    mockNotifyVacationCancelled.mockImplementation(trackedResolve("notify", undefined));
    mockNotifyVacationsCancelled.mockImplementation(trackedResolve("notify", undefined));
    mockNotifyVacationComment.mockImplementation(trackedResolve("notify", undefined));
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
  describe("cancellation", () => {
    const approvedVacation = (over: Record<string, unknown> = {}) =>
      pendingVacation({ approvedAt: new Date("2026-08-01T09:00:00Z"), ...over });

    it("appends the cancellation event inside the transaction and notifies after it commits", async () => {
      mockGetVacationById.mockResolvedValue(approvedVacation());
      mockDeleteVacation.mockImplementation(
        trackedResolve("mutate", approvedVacation({ deletedAt: new Date() }))
      );

      await cancelRequest({ auth: mockAuthData, vacationId: FIRST_ID, reason: null });

      expect(timeline).toEqual(["mutate", "event", "commit", "notify"]);
    });

    // The cancelled row has no `approvedAt` left, and the notifier reads it to
    // decide whether the cancellation is worth an email at all.
    it("notifies with the row as it stood before the cancellation", async () => {
      const before = approvedVacation();
      mockGetVacationById.mockResolvedValue(before);
      mockDeleteVacation.mockResolvedValue(
        pendingVacation({ deletedAt: new Date(), approvedAt: null })
      );

      await cancelRequest({ auth: mockAuthData, vacationId: FIRST_ID, reason: "Trip called off" });

      expect(mockNotifyVacationCancelled).toHaveBeenCalledWith(
        before,
        { id: "user_123", name: "Test User" },
        "Trip called off"
      );
      expect(mockCreateVacationEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          vacationId: FIRST_ID,
          eventType: "CANCELLED",
          actorUserId: "user_123",
          reason: "Trip called off",
        }),
        tx
      );
    });

    it("notifies a batch with the pre-cancellation rows", async () => {
      const rows = [approvedVacation(), approvedVacation({ id: SECOND_ID })];
      mockGetVacationsByIds.mockResolvedValue(rows);
      mockCancelVacationsBulk.mockResolvedValue(
        rows.map((row) => ({ ...row, deletedAt: new Date() }))
      );

      await cancelRequestBatch({
        auth: mockAuthData,
        vacationIds: [FIRST_ID, SECOND_ID],
        reason: "Plans changed",
      });

      expect(mockNotifyVacationsCancelled).toHaveBeenCalledWith(
        rows,
        { id: "user_123", name: "Test User" },
        "Plans changed"
      );
    });

    it("answers a lost single cancel with a conflict, not a server fault", async () => {
      mockGetVacationById.mockResolvedValue(approvedVacation());
      mockDeleteVacation.mockResolvedValue(undefined);

      await expect(
        cancelRequest({ auth: mockAuthData, vacationId: FIRST_ID, reason: null })
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "This request has already been cancelled",
      });

      expect(mockCreateVacationEvent).not.toHaveBeenCalled();
      expect(mockNotifyVacationCancelled).not.toHaveBeenCalled();
    });

    it("fails the whole batch when a bulk cancel loses the race", async () => {
      const rows = [approvedVacation(), approvedVacation({ id: SECOND_ID })];
      mockGetVacationsByIds.mockResolvedValue(rows);
      mockCancelVacationsBulk.mockResolvedValue([{ ...rows[0], deletedAt: new Date() }]);

      await expect(
        cancelRequestBatch({ auth: mockAuthData, vacationIds: [FIRST_ID, SECOND_ID], reason: null })
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "One or more of these requests has already been cancelled",
      });

      expect(mockCreateVacationEvents).not.toHaveBeenCalled();
      expect(mockNotifyVacationsCancelled).not.toHaveBeenCalled();
    });

    it("returns the rows a successful batch actually cancelled", async () => {
      const rows = [approvedVacation(), approvedVacation({ id: SECOND_ID })];
      mockGetVacationsByIds.mockResolvedValue(rows);
      mockCancelVacationsBulk.mockResolvedValue(
        rows.map((row) => ({ ...row, deletedAt: new Date() }))
      );

      const cancelled = await cancelRequestBatch({
        auth: mockAuthData,
        vacationIds: [FIRST_ID, SECOND_ID],
        reason: null,
      });

      expect(cancelled).toHaveLength(2);
      // The rows the update moved, not the rows the load found.
      expect(cancelled.every((row) => row.deletedAt !== null)).toBe(true);
      expect(mockCreateVacationEvents).toHaveBeenCalledWith(
        [
          expect.objectContaining({ vacationId: FIRST_ID, eventType: "CANCELLED" }),
          expect.objectContaining({ vacationId: SECOND_ID, eventType: "CANCELLED" }),
        ],
        tx
      );
    });

    it("lets the owner cancel a request they hold no approver standing over", async () => {
      mockGetGroupsWhereUserCanApprove.mockResolvedValue([]);
      mockGetVacationById.mockResolvedValue(approvedVacation({ userId: "user_123" }));
      mockDeleteVacation.mockResolvedValue(approvedVacation({ deletedAt: new Date() }));

      await cancelRequest({ auth: mockAuthData, vacationId: FIRST_ID, reason: null });

      expect(mockDeleteVacation).toHaveBeenCalledWith(FIRST_ID, "user_123", tx);
    });

    it("lets a group admin cancel someone else's request", async () => {
      mockGetGroupsWhereUserCanApprove.mockResolvedValue([]);
      mockResolveGroupAdmin.mockResolvedValue({ canAdmin: true, viaOrgAdmin: true });
      mockGetVacationById.mockResolvedValue(approvedVacation());
      mockDeleteVacation.mockResolvedValue(approvedVacation({ deletedAt: new Date() }));

      await cancelRequest({ auth: mockAuthData, vacationId: FIRST_ID, reason: null });

      expect(mockDeleteVacation).toHaveBeenCalled();
    });

    it("refuses a plain member cancelling someone else's request", async () => {
      mockGetGroupsWhereUserCanApprove.mockResolvedValue([]);
      mockGetVacationById.mockResolvedValue(approvedVacation());

      await expect(
        cancelRequest({ auth: mockAuthData, vacationId: FIRST_ID, reason: null })
      ).rejects.toThrow("You are not allowed to cancel this vacation");

      expect(mockDeleteVacation).not.toHaveBeenCalled();
    });

    it("keeps the bulk wording when a batch holds a request the caller may not cancel", async () => {
      mockGetGroupsWhereUserCanApprove.mockResolvedValue([]);
      mockGetVacationsByIds.mockResolvedValue([approvedVacation()]);

      await expect(
        cancelRequestBatch({ auth: mockAuthData, vacationIds: [FIRST_ID], reason: null })
      ).rejects.toThrow("You are not allowed to cancel one or more of these vacations");

      expect(mockCancelVacationsBulk).not.toHaveBeenCalled();
    });

    // The per-record resolver would have run this once per row inside an open
    // transaction holding row locks; the set-based one runs it once per group.
    it("resolves approver and admin standing once per distinct group", async () => {
      mockGetGroupsWhereUserCanApprove.mockResolvedValue(["group_123", "group_456"]);
      const rows = [
        approvedVacation(),
        approvedVacation({ id: SECOND_ID }),
        approvedVacation({ id: THIRD_ID, groupId: "group_456" }),
      ];
      mockGetVacationsByIds.mockResolvedValue(rows);
      mockCancelVacationsBulk.mockResolvedValue(rows);

      await cancelRequestBatch({
        auth: mockAuthData,
        vacationIds: [FIRST_ID, SECOND_ID, THIRD_ID],
        reason: null,
      });

      expect(mockGetGroupsWhereUserCanApprove).toHaveBeenCalledTimes(1);
      expect(mockGetGroupsWhereUserCanApprove).toHaveBeenCalledWith(
        ["group_123", "group_456"],
        "user_123",
        tx
      );
      expect(mockResolveGroupAdmin).toHaveBeenCalledTimes(2);
    });

    it("cancels an already-approved request, and runs no quota guard doing it", async () => {
      mockGetVacationById.mockResolvedValue(approvedVacation());
      mockDeleteVacation.mockResolvedValue(approvedVacation({ deletedAt: new Date() }));

      await cancelRequest({ auth: mockAuthData, vacationId: FIRST_ID, reason: null });

      expect(mockDeleteVacation).toHaveBeenCalled();
      expect(mockAssertApprovalWithinQuota).not.toHaveBeenCalled();
    });

    it("uses the single-record not-found wording", async () => {
      mockGetVacationById.mockResolvedValue(undefined);

      await expect(
        cancelRequest({ auth: mockAuthData, vacationId: FIRST_ID, reason: null })
      ).rejects.toThrow("Vacation not found");
    });
  });

  describe("comment", () => {
    it("appends the comment inside the transaction, changing no vacation row", async () => {
      mockGetVacationById.mockResolvedValue(pendingVacation());

      await commentOnRequest({
        auth: mockAuthData,
        vacationId: FIRST_ID,
        message: "Any update on this?",
      });

      expect(timeline).toEqual(["event", "commit", "notify"]);
      expect(mockCreateVacationEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          vacationId: FIRST_ID,
          eventType: "COMMENT",
          actorUserId: "user_123",
          reason: "Any update on this?",
        }),
        tx
      );
      expect(mockDeleteVacation).not.toHaveBeenCalled();
      expect(mockApproveVacation).not.toHaveBeenCalled();
      expect(mockRejectVacation).not.toHaveBeenCalled();
    });

    it("notifies with the row it loaded", async () => {
      const row = pendingVacation();
      mockGetVacationById.mockResolvedValue(row);

      await commentOnRequest({ auth: mockAuthData, vacationId: FIRST_ID, message: "Bumping this" });

      expect(mockNotifyVacationComment).toHaveBeenCalledWith(
        row,
        { id: "user_123", name: "Test User" },
        "Bumping this"
      );
    });

    it("refuses a caller who may not view the request", async () => {
      mockGetVacationById.mockResolvedValue(pendingVacation());
      mockResolveVacationPermissions.mockResolvedValue({ canView: false });

      await expect(
        commentOnRequest({ auth: mockAuthData, vacationId: FIRST_ID, message: "Hello" })
      ).rejects.toThrow("You are not allowed to comment on this vacation");

      expect(mockCreateVacationEvent).not.toHaveBeenCalled();
      expect(mockNotifyVacationComment).not.toHaveBeenCalled();
    });

    it("uses the single-record not-found wording", async () => {
      mockGetVacationById.mockResolvedValue(undefined);

      await expect(
        commentOnRequest({ auth: mockAuthData, vacationId: FIRST_ID, message: "Hello" })
      ).rejects.toThrow("Vacation not found");

      expect(mockResolveVacationPermissions).not.toHaveBeenCalled();
    });

    it("runs no quota guard", async () => {
      mockGetVacationById.mockResolvedValue(pendingVacation());

      await commentOnRequest({ auth: mockAuthData, vacationId: FIRST_ID, message: "Hello" });

      expect(mockAssertApprovalWithinQuota).not.toHaveBeenCalled();
    });
  });
});

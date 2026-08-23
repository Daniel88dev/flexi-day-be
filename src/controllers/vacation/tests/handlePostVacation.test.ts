import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Billing plan-limit guards are no-ops here; their behavior has its own suite.
vi.mock("../../../services/billing/guards.js", () => ({
  assertCanCreateGroup: vi.fn(),
  assertCanAddMember: vi.fn(),
  assertGroupWritable: vi.fn(),
  assertGroupsWritable: vi.fn(),
}));

const {
  mockPostVacationBulk,
  mockGetGroupUser,
  mockGetGroup,
  mockGetApprovalUsers,
  mockTransaction,
  mockCreateVacationEvents,
  mockNotifyVacationRequested,
  mockNotifyVacationDecision,
  mockNotifyVacationBookedOnBehalf,
  mockAssertRequestWithinQuota,
  mockAssertGroupAdmin,
  mockGetUserById,
} = vi.hoisted(() => ({
  mockPostVacationBulk: vi.fn(),
  mockGetGroupUser: vi.fn(),
  mockGetGroup: vi.fn(),
  mockGetApprovalUsers: vi.fn(),
  mockTransaction: vi.fn(),
  mockCreateVacationEvents: vi.fn(),
  mockNotifyVacationRequested: vi.fn(),
  mockNotifyVacationDecision: vi.fn(),
  mockNotifyVacationBookedOnBehalf: vi.fn(),
  mockAssertRequestWithinQuota: vi.fn(),
  mockAssertGroupAdmin: vi.fn(),
  mockGetUserById: vi.fn(),
}));

vi.mock("../../../services/groupUser/groupAccess.js", () => ({
  assertGroupAdmin: mockAssertGroupAdmin,
}));

vi.mock("../../../utils/generateUUID.js", () => ({
  generateRandomUUID: vi.fn(),
}));

vi.mock("../../../middleware/authSession.js", () => ({
  getAuth: vi.fn(),
}));

vi.mock("../../../services/vacation/vacationNotifier.js", () => ({
  notifyVacationRequested: mockNotifyVacationRequested,
  notifyVacationDecision: mockNotifyVacationDecision,
  notifyVacationBookedOnBehalf: mockNotifyVacationBookedOnBehalf,
}));

vi.mock("../../../services/vacation/quotaGuard.js", () => ({
  assertRequestWithinQuota: mockAssertRequestWithinQuota,
}));

vi.mock("../../../db/db.js", () => ({
  db: {
    transaction: mockTransaction,
  },
}));

vi.mock("../../../services/DBServices.js", () => ({
  createDBServices: () => ({
    vacation: {
      postVacationBulk: mockPostVacationBulk,
    },
    vacationEvent: {
      createVacationEvents: mockCreateVacationEvents,
    },
    groupUser: {
      getGroupUser: mockGetGroupUser,
    },
    group: {
      getGroup: mockGetGroup,
      getApprovalUsers: mockGetApprovalUsers,
    },
    user: {
      getUserById: mockGetUserById,
    },
  }),
}));

import { handlePostVacation } from "../handlePostVacation.js";
import { generateRandomUUID } from "../../../utils/generateUUID.js";
import { getAuth } from "../../../middleware/authSession.js";
import { makeReqRes, mockAuthData } from "../../../tests/testUtils.js";
import { vacationType } from "../../../db/schema/vacation-schema.js";

const baseBody = (overrides: Record<string, unknown> = {}) => ({
  groupId: "group_123",
  from: new Date("2024-03-15T00:00:00Z"),
  to: new Date("2024-03-15T00:00:00Z"),
  vacationType: vacationType.Vacation,
  startTime: "09:00",
  endTime: "17:00",
  note: null,
  ...overrides,
});

describe("handlePostVacation", () => {
  beforeEach(() => {
    // The controller bounds how far a range may sit from today, so the March
    // 2024 fixtures below (chosen for their weekdays) need a matching "today".
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2024-03-01T09:00:00Z"));

    vi.clearAllMocks();
    mockAssertRequestWithinQuota.mockResolvedValue(undefined);

    (getAuth as ReturnType<typeof vi.fn>).mockReturnValue(mockAuthData);

    let counter = 0;
    (generateRandomUUID as ReturnType<typeof vi.fn>).mockImplementation(
      () => `uuid_${(++counter).toString()}`
    );

    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({}));

    // Default to every weekday being a working day so tests that aren't about
    // the working-day filter keep booking every day in their range.
    mockGetGroup.mockResolvedValue({
      id: "group_123",
      workingDays: [0, 1, 2, 3, 4, 5, 6],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("should create vacation rows for a single-day range", async () => {
    const { req, res } = makeReqRes({ body: baseBody() });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: true,
    });

    const created = [
      {
        id: "uuid_1",
        userId: "user_123",
        groupId: "group_123",
        requestedDay: "2024-03-15",
      },
    ];
    mockPostVacationBulk.mockResolvedValue(created);
    mockGetApprovalUsers.mockResolvedValue(null);

    await handlePostVacation(req, res);

    expect(mockGetGroupUser).toHaveBeenCalledWith("user_123", "group_123");
    expect(mockPostVacationBulk).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          userId: "user_123",
          groupId: "group_123",
          requestedDay: "2024-03-15",
          vacationType: vacationType.Vacation,
        }),
      ],
      {}
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(created);
  });

  it("should fan out a multi-day range into per-day rows", async () => {
    const { req, res } = makeReqRes({
      body: baseBody({
        from: new Date("2024-03-14T00:00:00Z"),
        to: new Date("2024-03-16T00:00:00Z"),
      }),
    });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: true,
    });

    mockPostVacationBulk.mockImplementation(async (records: unknown[]) => records);
    mockGetApprovalUsers.mockResolvedValue(null);

    await handlePostVacation(req, res);

    const [records] = mockPostVacationBulk.mock.calls[0] as [{ requestedDay: string }[], unknown];
    expect(records.map((r) => r.requestedDay)).toEqual(["2024-03-14", "2024-03-15", "2024-03-16"]);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("should throw 403 when user has no access to group", async () => {
    const { req, res } = makeReqRes({ body: baseBody() });

    mockGetGroupUser.mockResolvedValue(null);

    await expect(handlePostVacation(req, res)).rejects.toThrow("No access for related group");
    expect(mockPostVacationBulk).not.toHaveBeenCalled();
  });

  it("should throw 403 when user is not a controlled user", async () => {
    const { req, res } = makeReqRes({ body: baseBody() });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: false,
    });

    await expect(handlePostVacation(req, res)).rejects.toThrow("No access for related group");
    expect(mockPostVacationBulk).not.toHaveBeenCalled();
  });

  it("should propagate conflict errors from postVacationBulk", async () => {
    const { req, res } = makeReqRes({ body: baseBody() });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: true,
    });

    mockPostVacationBulk.mockRejectedValue(
      new Error("One or more days in the requested range are already booked")
    );

    await expect(handlePostVacation(req, res)).rejects.toThrow(
      "One or more days in the requested range are already booked"
    );
  });

  it("should reject ranges where `to` is before `from`", async () => {
    const { req, res } = makeReqRes({
      body: baseBody({
        from: new Date("2024-03-20T00:00:00Z"),
        to: new Date("2024-03-19T00:00:00Z"),
      }),
    });

    await expect(handlePostVacation(req, res)).rejects.toThrow(
      "`to` must be greater than or equal to `from`"
    );
    expect(mockGetGroupUser).not.toHaveBeenCalled();
  });

  it("hands the committed rows to the approval notifier", async () => {
    const { req, res } = makeReqRes({ body: baseBody() });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: true,
    });
    mockPostVacationBulk.mockResolvedValue([{ id: "uuid_1" }]);

    await handlePostVacation(req, res);

    expect(mockNotifyVacationRequested).toHaveBeenCalledWith(
      [{ id: "uuid_1" }],
      { id: mockAuthData.userId, name: mockAuthData.userName },
      null
    );
  });

  it("should bubble up database errors from postVacationBulk", async () => {
    const { req, res } = makeReqRes({ body: baseBody() });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: true,
    });

    mockPostVacationBulk.mockRejectedValue(new Error("Insert failed"));

    await expect(handlePostVacation(req, res)).rejects.toThrow("Insert failed");
  });

  it("books only the group's working days within a range", async () => {
    // Thu 2024-03-14 .. Mon 2024-03-18 with Mon-Fri working days drops the
    // Sat/Sun in the middle.
    const { req, res } = makeReqRes({
      body: baseBody({
        from: new Date("2024-03-14T00:00:00Z"),
        to: new Date("2024-03-18T00:00:00Z"),
      }),
    });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: true,
    });
    mockGetGroup.mockResolvedValue({ id: "group_123", workingDays: [1, 2, 3, 4, 5] });
    mockPostVacationBulk.mockImplementation(async (records: unknown[]) => records);

    await handlePostVacation(req, res);

    const [records] = mockPostVacationBulk.mock.calls[0] as [{ requestedDay: string }[], unknown];
    expect(records.map((r) => r.requestedDay)).toEqual(["2024-03-14", "2024-03-15", "2024-03-18"]);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("rejects a single non-working day with a specific message", async () => {
    // 2024-03-16 is a Saturday.
    const { req, res } = makeReqRes({
      body: baseBody({
        from: new Date("2024-03-16T00:00:00Z"),
        to: new Date("2024-03-16T00:00:00Z"),
      }),
    });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: true,
    });
    mockGetGroup.mockResolvedValue({ id: "group_123", workingDays: [1, 2, 3, 4, 5] });

    await expect(handlePostVacation(req, res)).rejects.toThrow("Selected day is not a working day");
    expect(mockPostVacationBulk).not.toHaveBeenCalled();
  });

  it("rejects a range that contains no working day", async () => {
    // Sat 2024-03-16 .. Sun 2024-03-17.
    const { req, res } = makeReqRes({
      body: baseBody({
        from: new Date("2024-03-16T00:00:00Z"),
        to: new Date("2024-03-17T00:00:00Z"),
      }),
    });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: true,
    });
    mockGetGroup.mockResolvedValue({ id: "group_123", workingDays: [1, 2, 3, 4, 5] });

    await expect(handlePostVacation(req, res)).rejects.toThrow(
      "Selected range contains no working days"
    );
    expect(mockPostVacationBulk).not.toHaveBeenCalled();
  });

  describe("booking on behalf of a member", () => {
    const onBehalfBody = (overrides: Record<string, unknown> = {}) =>
      baseBody({ userId: "member_456", ...overrides });

    beforeEach(() => {
      mockAssertGroupAdmin.mockResolvedValue(undefined);
      mockGetGroupUser.mockResolvedValue({
        userId: "member_456",
        groupId: "group_123",
        controlledUser: true,
      });
      mockGetUserById.mockResolvedValue({
        id: "member_456",
        name: "Member Name",
        email: "member@example.com",
      });
      mockPostVacationBulk.mockImplementation(async (records: unknown[]) => records);
    });

    it("books for the target member, stamps the admin as creator, and notifies the member", async () => {
      const { req, res } = makeReqRes({ body: onBehalfBody() });

      await handlePostVacation(req, res);

      expect(mockAssertGroupAdmin).toHaveBeenCalledWith(mockAuthData.userId, "group_123");
      expect(mockGetGroupUser).toHaveBeenCalledWith("member_456", "group_123");
      expect(mockPostVacationBulk).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            userId: "member_456",
            createdByUserId: mockAuthData.userId,
          }),
        ],
        {}
      );
      const [records] = mockPostVacationBulk.mock.calls[0] as [{ approvedAt?: Date }[], unknown];
      expect(records[0]?.approvedAt).toBeUndefined();
      // Approvers are asked about the member's leave, not the admin's.
      expect(mockNotifyVacationRequested).toHaveBeenCalledWith(
        expect.any(Array),
        { id: "member_456", name: "Member Name" },
        null
      );
      expect(mockNotifyVacationBookedOnBehalf).toHaveBeenCalledWith(expect.any(Array), {
        id: mockAuthData.userId,
        name: mockAuthData.userName,
      });
      expect(mockNotifyVacationDecision).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it("creates already-approved rows with two timeline events when autoApprove is set", async () => {
      const { req, res } = makeReqRes({ body: onBehalfBody({ autoApprove: true }) });

      await handlePostVacation(req, res);

      expect(mockPostVacationBulk).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            userId: "member_456",
            createdByUserId: mockAuthData.userId,
            approvedBy: mockAuthData.userId,
            approvedAt: expect.any(Date),
          }),
        ],
        {}
      );
      const eventTypes = mockCreateVacationEvents.mock.calls.map(
        ([events]) => (events as { eventType: string }[])[0]?.eventType
      );
      expect(eventTypes).toEqual(["CREATED", "APPROVED"]);
      expect(mockNotifyVacationDecision).toHaveBeenCalledWith(expect.any(Array), "approved", {
        id: mockAuthData.userId,
        name: mockAuthData.userName,
      });
      expect(mockNotifyVacationRequested).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it("rejects a non-admin caller passing userId", async () => {
      const { req, res } = makeReqRes({ body: onBehalfBody() });
      mockAssertGroupAdmin.mockRejectedValue(new Error("No permission for related group"));

      await expect(handlePostVacation(req, res)).rejects.toThrow("No permission for related group");
      expect(mockPostVacationBulk).not.toHaveBeenCalled();
    });

    it("rejects autoApprove on a self-booking", async () => {
      const { req, res } = makeReqRes({
        body: baseBody({ userId: mockAuthData.userId, autoApprove: true }),
      });

      await expect(handlePostVacation(req, res)).rejects.toThrow(
        "`autoApprove` is only valid when booking on behalf of a member"
      );
      expect(mockAssertGroupAdmin).not.toHaveBeenCalled();
      expect(mockPostVacationBulk).not.toHaveBeenCalled();
    });

    it("rejects a target member who cannot book in the group", async () => {
      const { req, res } = makeReqRes({ body: onBehalfBody() });
      mockGetGroupUser.mockResolvedValue({
        userId: "member_456",
        groupId: "group_123",
        controlledUser: false,
      });

      await expect(handlePostVacation(req, res)).rejects.toThrow(
        "That member cannot book leave in this group"
      );
      expect(mockPostVacationBulk).not.toHaveBeenCalled();
    });

    it("aborts inside the transaction when the member's access was just revoked", async () => {
      const { req, res } = makeReqRes({ body: onBehalfBody() });
      // Pre-transaction check passes; the re-check on the tx snapshot does not.
      mockGetGroupUser
        .mockResolvedValueOnce({ userId: "member_456", groupId: "group_123", controlledUser: true })
        .mockResolvedValueOnce({
          userId: "member_456",
          groupId: "group_123",
          controlledUser: false,
        });

      await expect(handlePostVacation(req, res)).rejects.toThrow(
        "That member cannot book leave in this group"
      );
      expect(mockPostVacationBulk).not.toHaveBeenCalled();
      expect(mockGetGroupUser).toHaveBeenCalledTimes(2);
    });
  });

  it("throws 404 when the group no longer exists", async () => {
    const { req, res } = makeReqRes({ body: baseBody() });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: true,
    });
    mockGetGroup.mockResolvedValue(undefined);

    await expect(handlePostVacation(req, res)).rejects.toThrow("Group not found");
    expect(mockPostVacationBulk).not.toHaveBeenCalled();
  });
});

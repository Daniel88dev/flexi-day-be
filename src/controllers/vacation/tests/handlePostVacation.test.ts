import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockPostVacationBulk,
  mockGetGroupUser,
  mockGetGroup,
  mockGetApprovalUsers,
  mockTransaction,
  mockCreateVacationEvents,
  mockNotifyVacationRequested,
} = vi.hoisted(() => ({
  mockPostVacationBulk: vi.fn(),
  mockGetGroupUser: vi.fn(),
  mockGetGroup: vi.fn(),
  mockGetApprovalUsers: vi.fn(),
  mockTransaction: vi.fn(),
  mockCreateVacationEvents: vi.fn(),
  mockNotifyVacationRequested: vi.fn(),
}));

vi.mock("../../../utils/generateUUID.js", () => ({
  generateRandomUUID: vi.fn(),
}));

vi.mock("../../../middleware/authSession.js", () => ({
  getAuth: vi.fn(),
}));

vi.mock("../../../services/vacation/vacationNotifier.js", () => ({
  notifyVacationRequested: mockNotifyVacationRequested,
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
    vi.clearAllMocks();

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

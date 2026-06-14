import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockPostVacationBulk,
  mockGetGroupUser,
  mockGetApprovalUsers,
  mockTransaction,
} = vi.hoisted(() => ({
  mockPostVacationBulk: vi.fn(),
  mockGetGroupUser: vi.fn(),
  mockGetApprovalUsers: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock("../../../utils/generateUUID.js", () => ({
  generateRandomUUID: vi.fn(),
}));

vi.mock("../../../middleware/authSession.js", () => ({
  getAuth: vi.fn(),
}));

vi.mock("../../../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
  },
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
    groupUser: {
      getGroupUser: mockGetGroupUser,
    },
    group: {
      getApprovalUsers: mockGetApprovalUsers,
    },
  }),
}));

import { handlePostVacation } from "../handlePostVacation.js";
import { generateRandomUUID } from "../../../utils/generateUUID.js";
import { getAuth } from "../../../middleware/authSession.js";
import { logger } from "../../../middleware/logger.js";
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

    mockTransaction.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => cb({})
    );
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

    mockPostVacationBulk.mockImplementation(
      async (records: unknown[]) => records
    );
    mockGetApprovalUsers.mockResolvedValue(null);

    await handlePostVacation(req, res);

    const [records] = mockPostVacationBulk.mock.calls[0] as [
      { requestedDay: string }[],
      unknown,
    ];
    expect(records.map((r) => r.requestedDay)).toEqual([
      "2024-03-14",
      "2024-03-15",
      "2024-03-16",
    ]);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("should throw 403 when user has no access to group", async () => {
    const { req, res } = makeReqRes({ body: baseBody() });

    mockGetGroupUser.mockResolvedValue(null);

    await expect(handlePostVacation(req, res)).rejects.toThrow(
      "No access for related group"
    );
    expect(mockPostVacationBulk).not.toHaveBeenCalled();
  });

  it("should throw 403 when user is not a controlled user", async () => {
    const { req, res } = makeReqRes({ body: baseBody() });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: false,
    });

    await expect(handlePostVacation(req, res)).rejects.toThrow(
      "No access for related group"
    );
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

  it("should log info when main approval user email is available", async () => {
    const { req, res } = makeReqRes({ body: baseBody() });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: true,
    });
    mockPostVacationBulk.mockResolvedValue([{ id: "uuid_1" }]);
    mockGetApprovalUsers.mockResolvedValue({
      mainApprovalUserEmail: "approver@example.com",
    });

    await handlePostVacation(req, res);

    expect(mockGetApprovalUsers).toHaveBeenCalledWith("group_123");
    expect(logger.info).toHaveBeenCalledWith(
      "notification email not-sent (not finished"
    );
  });

  it("should log info when temp approval user email is available", async () => {
    const { req, res } = makeReqRes({ body: baseBody() });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: true,
    });
    mockPostVacationBulk.mockResolvedValue([{ id: "uuid_1" }]);
    mockGetApprovalUsers.mockResolvedValue({
      tempApprovalUserEmail: "temp_approver@example.com",
    });

    await handlePostVacation(req, res);

    expect(mockGetApprovalUsers).toHaveBeenCalledWith("group_123");
    expect(logger.info).toHaveBeenCalledWith(
      "notification email not-sent (not finished"
    );
  });

  it("should not log info when no approval user emails are available", async () => {
    const { req, res } = makeReqRes({ body: baseBody() });

    mockGetGroupUser.mockResolvedValue({
      userId: "user_123",
      groupId: "group_123",
      controlledUser: true,
    });
    mockPostVacationBulk.mockResolvedValue([{ id: "uuid_1" }]);
    mockGetApprovalUsers.mockResolvedValue({
      mainApprovalUserEmail: null,
      tempApprovalUserEmail: null,
    });

    await handlePostVacation(req, res);

    expect(logger.info).not.toHaveBeenCalled();
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
});
